import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError } from "@azure/storage-blob";

/** Without this App Setting every file stays on Supabase Storage, so removing it turns Blob off. */
export function isBlobStoreOn() {
  return Boolean(process.env.AZURE_BLOB_ACCOUNT_URL?.trim());
}

const globalClient = globalThis as unknown as { __chatbaseBlobClient?: BlobServiceClient };

function service() {
  globalClient.__chatbaseBlobClient ??= new BlobServiceClient(
    process.env.AZURE_BLOB_ACCOUNT_URL!.trim(),
    // Managed identity on App Service, the Azure CLI login on a developer machine.
    new DefaultAzureCredential(),
    { retryOptions: { maxTries: 3, tryTimeoutInMs: 60_000 } },
  );
  return globalClient.__chatbaseBlobClient;
}

function statusOf(err: unknown) {
  return err instanceof RestError ? err.statusCode : undefined;
}

/** Never overwrites: returns false when the blob already exists. */
export async function putBlob(
  container: string,
  path: string,
  bytes: Buffer,
  contentType: string,
): Promise<boolean> {
  try {
    await service()
      .getContainerClient(container)
      .getBlockBlobClient(path)
      .uploadData(bytes, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          blobContentMD5: createHash("md5").update(bytes).digest(),
        },
        conditions: { ifNoneMatch: "*" },
      });
    return true;
  } catch (err) {
    const status = statusOf(err);
    if (status === 409 || status === 412) return false;
    throw err;
  }
}

/** The file, or null when it is not there. */
export async function getBlob(container: string, path: string): Promise<Blob | null> {
  try {
    const response = await service()
      .getContainerClient(container)
      .getBlobClient(path)
      .download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return new Blob([Buffer.concat(chunks)], { type: response.contentType ?? "" });
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}
