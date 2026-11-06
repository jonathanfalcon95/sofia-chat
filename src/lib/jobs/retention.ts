/** Below this, a retried webhook could be processed twice: YCloud retries for about 6 hours. */
const MIN_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 30;

export function retentionDays(setting: string | undefined) {
  const days = Number(setting);
  if (setting === undefined || setting.trim() === "" || !Number.isInteger(days)) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.max(days, MIN_RETENTION_DAYS);
}

/** Small batches with a pause between them, because the database is shared with other apps. */
export async function deleteInBatches(args: {
  deleteBatch: (size: number) => Promise<number>;
  batchSize: number;
  maxBatches: number;
  pause: () => Promise<void>;
}): Promise<number> {
  let total = 0;
  for (let i = 0; i < args.maxBatches; i++) {
    const deleted = await args.deleteBatch(args.batchSize);
    total += deleted;
    if (deleted < args.batchSize) break;
    await args.pause();
  }
  return total;
}
