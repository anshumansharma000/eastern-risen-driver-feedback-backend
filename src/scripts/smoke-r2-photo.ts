import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { loadConfig } from '../config/env.js';
import { R2PhotoStorage } from '../shared/storage/photo-storage.js';

const config = loadConfig();
if (!config.r2) throw new Error('R2 photo storage is not configured');

const storage = new R2PhotoStorage(config.r2);
const id = randomUUID();
const uploadObjectKey = storage.buildUploadObjectKey('smoke-test', id);
const storedObjectKey = storage.buildStoredObjectKey('smoke-test', id);

try {
  const source = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#336699' },
  })
    .png()
    .toBuffer();
  const uploadUrl = await storage.createUploadUrl(uploadObjectKey, 'image/png');
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: source,
  });
  if (!upload.ok) throw new Error(`R2 test upload failed with HTTP ${upload.status}`);

  const sanitized = await storage.sanitize(uploadObjectKey, storedObjectKey, 'image/png');
  const downloadUrl = await storage.createDownloadUrl(storedObjectKey);
  const download = await fetch(downloadUrl);
  if (!download.ok) throw new Error(`R2 test download failed with HTTP ${download.status}`);
  const downloaded = Buffer.from(await download.arrayBuffer());
  if (downloaded.byteLength !== sanitized.byteSize) {
    throw new Error('R2 test download size did not match sanitized object metadata');
  }
  process.stdout.write('R2 photo upload, sanitization, download, and access test passed\n');
} finally {
  await Promise.allSettled([storage.delete(uploadObjectKey), storage.delete(storedObjectKey)]);
}
