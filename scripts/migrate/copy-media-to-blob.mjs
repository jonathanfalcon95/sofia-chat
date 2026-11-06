// Copies the chat-media bucket from Supabase Storage to the chat-media container in Azure Blob.
// Nothing is deleted from Supabase. Safe to run again: blobs already there are skipped.
//
//   node scripts/migrate/copy-media-to-blob.mjs           counts only
//   node scripts/migrate/copy-media-to-blob.mjs --apply   copies what is missing
//   node scripts/migrate/copy-media-to-blob.mjs --verify  compares everything, reports differences
//
// Needs DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AZURE_BLOB_ACCOUNT_URL and
// an Azure CLI login with access to the container. Prints counts, never file names or contents.
import { createHash } from "node:crypto";
import { AzureCliCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import pg from "pg";

const CONTAINER = "chat-media";
const CONCURRENCY = 4;
const SAMPLE = 50;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta ${name}`);
  return value;
}

const container = new BlobServiceClient(
  required("AZURE_BLOB_ACCOUNT_URL"),
  new AzureCliCredential(),
).getContainerClient(CONTAINER);
const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");

async function sourceObjects() {
  const client = new pg.Client({
    connectionString: required("DATABASE_URL").replace(/[?&]sslmode=[^&]*/, ""),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120_000,
  });
  await client.connect();
  const { rows } = await client.query(`
    SELECT name,
           (metadata->>'size')::bigint AS size,
           metadata->>'mimetype' AS mime,
           replace(metadata->>'eTag', '"', '') AS etag
    FROM storage.objects
    WHERE bucket_id = 'chat-media'
    ORDER BY created_at`);
  await client.end();
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

async function existingBlobs() {
  const blobs = new Map();
  for await (const blob of container.listBlobsFlat()) {
    blobs.set(blob.name, {
      size: Number(blob.properties.contentLength),
      md5: blob.properties.contentMD5 ? Buffer.from(blob.properties.contentMD5).toString("hex") : null,
    });
  }
  return blobs;
}

async function download(name) {
  const path = name.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${supabaseUrl}/storage/v1/object/${CONTAINER}/${path}`, {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (!response.ok) throw new Error(`descarga ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const md5 = (bytes) => createHash("md5").update(bytes).digest();
const isMd5 = (etag) => /^[0-9a-f]{32}$/i.test(etag ?? "");

async function copyOne(object) {
  const bytes = await download(object.name);
  if (bytes.length !== object.size) throw new Error("tamaño distinto al descargar");
  const hash = md5(bytes);
  if (isMd5(object.etag) && hash.toString("hex") !== object.etag.toLowerCase()) {
    throw new Error("md5 distinto al descargar");
  }
  await container.getBlockBlobClient(object.name).uploadData(bytes, {
    blobHTTPHeaders: {
      blobContentType: object.mime || "application/octet-stream",
      blobContentMD5: hash,
    },
    conditions: { ifNoneMatch: "*" },
  });
}

async function forEachLimited(items, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

async function apply() {
  const [objects, blobs] = await Promise.all([sourceObjects(), existingBlobs()]);
  const missing = objects.filter((object) => !blobs.has(object.name));
  console.log(JSON.stringify({ origen: objects.length, yaEnBlob: objects.length - missing.length, porCopiar: missing.length }));

  const errors = {};
  let copied = 0;
  let done = 0;
  await forEachLimited(missing, async (object) => {
    try {
      await copyOne(object);
      copied += 1;
    } catch (err) {
      const label = err?.statusCode ?? err?.message ?? "error";
      errors[label] = (errors[label] ?? 0) + 1;
    }
    done += 1;
    if (done % 200 === 0) console.log(`avance ${done}/${missing.length}`);
  });
  console.log(JSON.stringify({ copiados: copied, errores: errors }));
  if (Object.keys(errors).length) process.exitCode = 1;
}

async function verify() {
  const [objects, blobs] = await Promise.all([sourceObjects(), existingBlobs()]);
  const report = { origen: objects.length, enBlob: blobs.size, faltan: 0, tamanoDistinto: 0, md5Distinto: 0, md5Comparados: 0 };
  for (const object of objects) {
    const blob = blobs.get(object.name);
    if (!blob) {
      report.faltan += 1;
      continue;
    }
    if (blob.size !== object.size) report.tamanoDistinto += 1;
    if (isMd5(object.etag) && blob.md5) {
      report.md5Comparados += 1;
      if (blob.md5 !== object.etag.toLowerCase()) report.md5Distinto += 1;
    }
  }

  // Byte by byte on a random sample, reading both copies.
  const present = objects.filter((object) => blobs.has(object.name));
  const sample = present.sort(() => Math.random() - 0.5).slice(0, SAMPLE);
  report.muestra = sample.length;
  report.muestraDistinta = 0;
  await forEachLimited(sample, async (object) => {
    const [source, copy] = await Promise.all([
      download(object.name),
      container.getBlobClient(object.name).downloadToBuffer(),
    ]);
    if (!source.equals(copy)) report.muestraDistinta += 1;
  });

  console.log(JSON.stringify(report));
  if (report.faltan || report.tamanoDistinto || report.md5Distinto || report.muestraDistinta) {
    process.exitCode = 1;
  }
}

async function counts() {
  const [objects, blobs] = await Promise.all([sourceObjects(), existingBlobs()]);
  const missing = objects.filter((object) => !blobs.has(object.name));
  const megabytes = missing.reduce((sum, object) => sum + object.size, 0) / 1048576;
  console.log(JSON.stringify({ origen: objects.length, enBlob: blobs.size, porCopiar: missing.length, mbPorCopiar: Math.round(megabytes) }));
}

const mode = process.argv[2];
try {
  if (mode === "--apply") await apply();
  else if (mode === "--verify") await verify();
  else if (mode === undefined) await counts();
  else throw new Error("Opciones: --apply | --verify");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
process.exit();
