import 'dotenv/config';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { feedbackPhotos } from '../database/schema/index.js';
import { R2PhotoStorage } from '../shared/storage/photo-storage.js';

const config = loadConfig();
if (!config.r2) throw new Error('R2 photo storage must be configured to clean orphan uploads');

const database = createDatabaseClient(config);
const storage = new R2PhotoStorage(config.r2);

try {
  const now = new Date();
  const cutoff = new Date(now.getTime() - storage.orphanTtlHours * 60 * 60 * 1000);
  const expiredTemporaryObjects = await database.db
    .select({ id: feedbackPhotos.id, uploadObjectKey: feedbackPhotos.uploadObjectKey })
    .from(feedbackPhotos)
    .where(
      and(isNull(feedbackPhotos.temporaryObjectCleanedAt), lt(feedbackPhotos.uploadExpiresAt, now)),
    );
  for (const photo of expiredTemporaryObjects) {
    await storage.delete(photo.uploadObjectKey);
    await database.db
      .update(feedbackPhotos)
      .set({ temporaryObjectCleanedAt: now })
      .where(and(eq(feedbackPhotos.id, photo.id), isNull(feedbackPhotos.temporaryObjectCleanedAt)));
  }

  const stale = await database.db
    .select({ id: feedbackPhotos.id })
    .from(feedbackPhotos)
    .where(
      and(
        inArray(feedbackPhotos.status, ['PENDING', 'PROCESSING', 'READY', 'REJECTED']),
        isNull(feedbackPhotos.feedbackSubmissionId),
        lt(feedbackPhotos.createdAt, cutoff),
      ),
    );

  let deleted = 0;
  for (const candidate of stale) {
    const [claimed] = await database.db
      .update(feedbackPhotos)
      .set({ status: 'REJECTED' })
      .where(
        and(
          eq(feedbackPhotos.id, candidate.id),
          inArray(feedbackPhotos.status, ['PENDING', 'PROCESSING', 'READY', 'REJECTED']),
          isNull(feedbackPhotos.feedbackSubmissionId),
          lt(feedbackPhotos.createdAt, cutoff),
        ),
      )
      .returning({
        id: feedbackPhotos.id,
        uploadObjectKey: feedbackPhotos.uploadObjectKey,
        objectKey: feedbackPhotos.objectKey,
      });
    if (!claimed) continue;
    await Promise.all([storage.delete(claimed.uploadObjectKey), storage.delete(claimed.objectKey)]);
    await database.db
      .delete(feedbackPhotos)
      .where(and(eq(feedbackPhotos.id, claimed.id), eq(feedbackPhotos.status, 'REJECTED')));
    deleted += 1;
  }
  process.stdout.write(`Deleted ${deleted} orphaned feedback photo uploads\n`);
} finally {
  await database.close();
}
