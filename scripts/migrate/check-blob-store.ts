// Checks the storage code against the real container and database, with its own test files, which
// it deletes. Touches no customer row: database writes roll back. Prints no file names or contents.
//
//   npx -y tsx scripts/migrate/check-blob-store.ts
//
// Needs AZURE_BLOB_ACCOUNT_URL, an identity with access to the container, the SQL_* settings and
// DATA_BACKEND=sqlserver.
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { AzureCliCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { getSystemDb } from "@/lib/db/client";
import { downloadStorageObject, uploadChatMedia } from "@/lib/db/repos/storage";
import { execute, transaction } from "@/lib/db/sqlserver/connection";
import { sql } from "@/lib/db/sqlserver/sql";
import { systemSqlDb, type SqlDb } from "@/lib/db/sqlserver/db";
import { updateMessagesMediaByYCloudIds } from "@/lib/db/sqlserver/repos/messaging";
import { archiveDeps } from "@/lib/jobs/background";
import { getBlob, putBlob } from "@/lib/storage/blob-store";

const CONTAINER = "chat-media";
const prefix = `__prueba/${randomUUID()}`;
const results: Record<string, unknown> = {};

async function check(name: string, work: () => Promise<unknown>) {
  try {
    const detail = await work();
    results[name] = detail === undefined ? "ok" : detail;
  } catch (err) {
    results[name] = `FALLO: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`;
    process.exitCode = 1;
  }
}

async function main() {
  const accountUrl = process.env.AZURE_BLOB_ACCOUNT_URL!.trim();
  const admin = new BlobServiceClient(accountUrl, new AzureCliCredential()).getContainerClient(CONTAINER);

  await check("contenedor privado", async () => {
    const properties = await admin.getProperties();
    assert.equal(properties.blobPublicAccess ?? null, null);
    const anonymous = await fetch(`${accountUrl.replace(/\/$/, "")}/${CONTAINER}?restype=container&comp=list`);
    assert.notEqual(anonymous.status, 200);
    return { accesoAnonimo: anonymous.status };
  });

  const bytes = randomBytes(1024);
  const path = `${prefix}/archivo.jpg`;

  await check("subir y leer lo mismo", async () => {
    assert.equal(await putBlob(CONTAINER, path, bytes, "image/jpeg"), true);
    const file = await getBlob(CONTAINER, path);
    assert.ok(file);
    assert.equal(file.type, "image/jpeg");
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes));
  });

  await check("no sobrescribe", async () => {
    assert.equal(await putBlob(CONTAINER, path, randomBytes(10), "text/plain"), false);
    const file = await getBlob(CONTAINER, path);
    assert.ok(Buffer.from(await file!.arrayBuffer()).equals(bytes));
  });

  await check("archivo inexistente da null", async () => {
    assert.equal(await getBlob(CONTAINER, `${prefix}/no-existe`), null);
  });

  await check("nombre con espacios, acentos y emoji", async () => {
    const odd = `${prefix}/año nuevo (1) 😀 #1.pdf`;
    const content = randomBytes(100);
    assert.equal(await putBlob(CONTAINER, odd, content, "application/pdf"), true);
    const file = await getBlob(CONTAINER, odd);
    assert.ok(Buffer.from(await file!.arrayBuffer()).equals(content));
  });

  await check("archivo grande de 20 MB", async () => {
    const big = randomBytes(20 * 1024 * 1024);
    const started = Date.now();
    assert.equal(await putBlob(CONTAINER, `${prefix}/grande.bin`, big, "video/mp4"), true);
    const uploaded = Date.now() - started;
    const file = await getBlob(CONTAINER, `${prefix}/grande.bin`);
    assert.ok(Buffer.from(await file!.arrayBuffer()).equals(big));
    return { subidaMs: uploaded, totalMs: Date.now() - started };
  });

  const db = getSystemDb();

  await check("el repositorio sube a Blob", async () => {
    const repoPath = `${prefix}/repo.ogg`;
    const content = randomBytes(200);
    const { error } = await uploadChatMedia(db, repoPath, content, "audio/ogg");
    assert.equal(error, null);
    assert.equal(await admin.getBlobClient(repoPath).exists(), true);
    const { data, error: readError } = await downloadStorageObject(db, CONTAINER, repoPath);
    assert.equal(readError, null);
    assert.ok(Buffer.from(await data!.arrayBuffer()).equals(content));
  });

  await check("un archivo que no está en ningún lado da error, no excepción", async () => {
    const { data, error } = await downloadStorageObject(db, CONTAINER, `${prefix}/ninguno`);
    assert.equal(data, null);
    assert.ok(error);
  });

  await check("archivo aún en Supabase se encuentra por el respaldo", async () => {
    const [row] = await execute(sql`
      SELECT TOP (1) media_url FROM chatbase.messages
      WHERE type IN (N'image', N'audio', N'video', N'document', N'sticker')
        AND media_url LIKE 'storage:chat-media/%'
      ORDER BY created_at DESC`);
    if (!row) return "sin archivos";
    const objectPath = String(row.media_url).slice("storage:chat-media/".length);
    if (await admin.getBlobClient(objectPath).exists()) return "ya copiado a Blob, sin respaldo que probar";
    const { data, error } = await downloadStorageObject(db, CONTAINER, objectPath);
    assert.equal(error, null);
    assert.ok(data && data.size > 0);
    return { bytesLeidos: data.size > 0 };
  });

  await check("los eventos no pisan una referencia guardada", async () => {
    const statements: string[] = [];
    const recording: SqlDb = {
      ...systemSqlDb(),
      run: async (statement) => {
        statements.push(statement.text);
        return [];
      },
    };
    await updateMessagesMediaByYCloudIds(recording, ["id-de-prueba"], { media_url: "https://x" });
    assert.ok(statements.some((text) => text.includes("NOT LIKE 'storage:%'")));
  });

  await check("consulta de pendientes", async () => {
    const started = Date.now();
    const rows = await archiveDeps.listPending(25, []);
    const first = Date.now() - started;
    const excluded = rows.slice(0, 5).map((row) => row.id);
    const again = await archiveDeps.listPending(25, excluded);
    assert.ok(again.every((row) => !excluded.includes(row.id)));
    assert.ok(rows.every((row) => row.mediaUrl.startsWith("https://api.ycloud.com/")));
    return { filas: rows.length, ms: first, exclusionesRespetadas: excluded.length };
  });

  await check("el usuario de la app puede borrar eventos, sin confirmar el borrado", async () => {
    const [before] = await execute(sql`SELECT COUNT(*) AS n FROM chatbase.webhook_events`);
    let deleted = -1;
    const sentinel = new Error("rollback a propósito");
    await transaction(async (run) => {
      const [row] = await run(sql`
        DELETE TOP (3) FROM chatbase.webhook_events
        WHERE processed_at < DATEADD(DAY, 0, SYSUTCDATETIME());
        SELECT @@ROWCOUNT AS deleted;`);
      deleted = Number(row?.deleted);
      throw sentinel;
    }).catch((err) => {
      if (err !== sentinel) throw err;
    });
    const [after] = await execute(sql`SELECT COUNT(*) AS n FROM chatbase.webhook_events`);
    assert.equal(deleted, 3);
    assert.ok(Number(after!.n) >= Number(before!.n));
    return { borradosEnTransaccionRevertida: deleted };
  });

  await check("limpieza de archivos de prueba", async () => {
    let removed = 0;
    for await (const blob of admin.listBlobsFlat({ prefix })) {
      await admin.getBlobClient(blob.name).delete();
      removed += 1;
    }
    return { borrados: removed };
  });

  console.log(JSON.stringify(results, null, 1));
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.slice(0, 300) : "fallo");
  process.exit(1);
});
