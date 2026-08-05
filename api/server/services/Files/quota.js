const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

const megabyte = 1024 * 1024;

const getStorageLimit = () =>
  (parseInt(process.env.USER_STORAGE_LIMIT_MB, 10) || 500) * megabyte;

/** Total bytes currently stored for a user. */
async function getUserStorageUsage(userId) {
  try {
    const files = await db.getFiles({ user: userId }, null, { bytes: 1 });
    return files.reduce((sum, f) => sum + (f.bytes ?? 0), 0);
  } catch (err) {
    logger.error('[storageQuota] usage lookup failed:', err);
    return 0; // fail open — never block uploads because the query broke
  }
}

/** Throws if this upload would push the user over quota. */
async function assertWithinStorageQuota(req) {
  const limit = getStorageLimit();
  if (limit <= 0) {
    return; // 0 disables the quota
  }
  const incoming = req.file?.size ?? 0;
  const used = await getUserStorageUsage(req.user.id);
  if (used + incoming > limit) {
    throw new Error(
      `Storage limit reached: you are using ${(used / megabyte).toFixed(1)} MB of your ` +
        `${(limit / megabyte).toFixed(0)} MB allowance. Delete some uploaded files before adding more.`,
    );
  }
}

module.exports = { getUserStorageUsage, getStorageLimit, assertWithinStorageQuota, megabyte };