import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { R2Config } from '../../config/env.js';
import { InvalidStoredPhotoError, R2PhotoStorage, sanitizePhotoBuffer } from './photo-storage.js';

describe('feedback photo sanitization', () => {
  it('separates reusable temporary upload keys from immutable stored keys', async () => {
    const storage = new R2PhotoStorage(testR2Config);
    const uploadKey = storage.buildUploadObjectKey('trip-id', 'photo-id');
    const storedKey = storage.buildStoredObjectKey('trip-id', 'photo-id');

    expect(uploadKey).toBe('feedbackphotos/pending/trip-id/photo-id');
    expect(storedKey).toBe('feedbackphotos/stored/trip-id/photo-id.jpg');
    expect(uploadKey).not.toBe(storedKey);

    const uploadUrl = new URL(await storage.createUploadUrl(uploadKey, 'image/png'));
    expect(uploadUrl.hostname).toBe('easternrisen.account-id.r2.cloudflarestorage.com');
    expect(uploadUrl.pathname).toBe(`/${uploadKey}`);
    expect(uploadUrl.searchParams.get('X-Amz-Expires')).toBe('600');
  });

  it('normalizes supported images to bounded metadata-free JPEGs', async () => {
    const source = await sharp({
      create: {
        width: 3000,
        height: 1000,
        channels: 3,
        background: '#336699',
      },
    })
      .png()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const sanitized = await sanitizePhotoBuffer(source);
    const metadata = await sharp(sanitized).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(2400);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it('rejects content that is not a supported image', async () => {
    await expect(sanitizePhotoBuffer(Buffer.from('not an image'))).rejects.toBeInstanceOf(
      InvalidStoredPhotoError,
    );
  });
});

const testR2Config: R2Config = {
  accountId: 'account-id',
  bucketName: 'easternrisen',
  keyPrefix: 'feedbackphotos',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  endpoint: 'https://account-id.r2.cloudflarestorage.com/',
  uploadUrlTtlSeconds: 600,
  downloadUrlTtlSeconds: 300,
  maxUploadBytes: 10 * 1024 * 1024,
  orphanTtlHours: 24,
};
