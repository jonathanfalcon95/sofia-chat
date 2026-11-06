/**
 * Blob first, Supabase Storage behind it. Files not copied yet are still found, and a Blob outage
 * must not lose a file a user just sent.
 */

export async function downloadWithFallback<T>(args: {
  fromBlob: () => Promise<Blob | null>;
  fromSupabase: () => Promise<T>;
  onBlobError: (err: unknown) => void;
}): Promise<T | { data: Blob; error: null }> {
  try {
    const file = await args.fromBlob();
    if (file) return { data: file, error: null };
  } catch (err) {
    args.onBlobError(err);
  }
  return args.fromSupabase();
}

export async function uploadWithFallback<T>(args: {
  toBlob: () => Promise<unknown>;
  toSupabase: () => Promise<T>;
  onBlobError: (err: unknown) => void;
}): Promise<T | { data: null; error: null }> {
  try {
    await args.toBlob();
    return { data: null, error: null };
  } catch (err) {
    args.onBlobError(err);
    return args.toSupabase();
  }
}
