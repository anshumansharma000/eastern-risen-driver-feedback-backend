import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import type { R2Config } from '../../config/env.js';

export const acceptedPhotoContentTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedPhotoContentType = (typeof acceptedPhotoContentTypes)[number];

export interface SanitizedPhoto {
  readonly contentType: 'image/jpeg';
  readonly byteSize: number;
}

export interface PhotoStorage {
  readonly enabled: boolean;
  readonly maxUploadBytes: number;
  readonly uploadUrlTtlSeconds: number;
  readonly downloadUrlTtlSeconds: number;
  readonly orphanTtlHours: number;
  buildUploadObjectKey(tripId: string, photoId: string): string;
  buildStoredObjectKey(tripId: string, photoId: string): string;
  createUploadUrl(objectKey: string, contentType: AcceptedPhotoContentType): Promise<string>;
  sanitize(
    uploadObjectKey: string,
    storedObjectKey: string,
    declaredContentType: AcceptedPhotoContentType,
  ): Promise<SanitizedPhoto>;
  createDownloadUrl(objectKey: string): Promise<string>;
  delete(objectKey: string): Promise<void>;
}

export class R2PhotoStorage implements PhotoStorage {
  readonly enabled = true;
  readonly maxUploadBytes: number;
  readonly uploadUrlTtlSeconds: number;
  readonly downloadUrlTtlSeconds: number;
  readonly orphanTtlHours: number;
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.maxUploadBytes = config.maxUploadBytes;
    this.uploadUrlTtlSeconds = config.uploadUrlTtlSeconds;
    this.downloadUrlTtlSeconds = config.downloadUrlTtlSeconds;
    this.orphanTtlHours = config.orphanTtlHours;
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  buildUploadObjectKey(tripId: string, photoId: string): string {
    return `${this.config.keyPrefix}/pending/${tripId}/${photoId}`;
  }

  buildStoredObjectKey(tripId: string, photoId: string): string {
    return `${this.config.keyPrefix}/stored/${tripId}/${photoId}.jpg`;
  }

  createUploadUrl(objectKey: string, contentType: AcceptedPhotoContentType): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: objectKey,
        ContentType: contentType,
      }),
      { expiresIn: this.uploadUrlTtlSeconds },
    );
  }

  async sanitize(
    uploadObjectKey: string,
    storedObjectKey: string,
    declaredContentType: AcceptedPhotoContentType,
  ): Promise<SanitizedPhoto> {
    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucketName, Key: uploadObjectKey }),
      );
    } catch (error) {
      if (!isStorageNotFound(error)) throw error;
      const stored = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucketName, Key: storedObjectKey }),
      );
      const storedByteSize = stored.ContentLength ?? 0;
      if (
        stored.ContentType !== 'image/jpeg' ||
        storedByteSize <= 0 ||
        storedByteSize > this.maxUploadBytes
      ) {
        throw new InvalidStoredPhotoError('Stored photo could not be verified');
      }
      return { contentType: 'image/jpeg', byteSize: storedByteSize };
    }
    const byteSize = head.ContentLength ?? 0;
    if (byteSize <= 0 || byteSize > this.maxUploadBytes) {
      throw new InvalidStoredPhotoError('Photo size is invalid');
    }
    if (head.ContentType !== declaredContentType) {
      throw new InvalidStoredPhotoError('Uploaded photo content type does not match the intent');
    }

    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucketName, Key: uploadObjectKey }),
    );
    if (!response.Body) throw new InvalidStoredPhotoError('Uploaded photo is empty');
    const source = Buffer.from(await response.Body.transformToByteArray());
    if (source.byteLength !== byteSize || source.byteLength > this.maxUploadBytes) {
      throw new InvalidStoredPhotoError('Uploaded photo size could not be verified');
    }

    const sanitized = await sanitizePhotoBuffer(source);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: storedObjectKey,
        Body: sanitized,
        ContentType: 'image/jpeg',
        ContentLength: sanitized.byteLength,
        CacheControl: 'private, no-store',
      }),
    );
    await this.delete(uploadObjectKey);
    return { contentType: 'image/jpeg', byteSize: sanitized.byteLength };
  }

  createDownloadUrl(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucketName,
        Key: objectKey,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: this.downloadUrlTtlSeconds },
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: objectKey }),
    );
  }
}

export class DisabledPhotoStorage implements PhotoStorage {
  readonly enabled = false;
  readonly maxUploadBytes = 10 * 1024 * 1024;
  readonly uploadUrlTtlSeconds = 600;
  readonly downloadUrlTtlSeconds = 300;
  readonly orphanTtlHours = 24;

  buildUploadObjectKey(): string {
    throw new PhotoStorageUnavailableError();
  }
  buildStoredObjectKey(): string {
    throw new PhotoStorageUnavailableError();
  }
  createUploadUrl(): Promise<string> {
    throw new PhotoStorageUnavailableError();
  }
  sanitize(): Promise<SanitizedPhoto> {
    throw new PhotoStorageUnavailableError();
  }
  createDownloadUrl(): Promise<string> {
    throw new PhotoStorageUnavailableError();
  }
  delete(): Promise<void> {
    throw new PhotoStorageUnavailableError();
  }
}

export class PhotoStorageUnavailableError extends Error {
  constructor() {
    super('Photo storage is not configured');
    this.name = 'PhotoStorageUnavailableError';
  }
}

export class InvalidStoredPhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStoredPhotoError';
  }
}

export async function sanitizePhotoBuffer(source: Buffer): Promise<Buffer> {
  try {
    const image = sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw new InvalidStoredPhotoError('Unsupported image format');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new InvalidStoredPhotoError('Animated images are not supported');
    }
    return await image
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch (error) {
    if (error instanceof InvalidStoredPhotoError) throw error;
    throw new InvalidStoredPhotoError('The uploaded file is not a valid supported image');
  }
}

function isStorageNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    error.$metadata.httpStatusCode === 404
  );
}
