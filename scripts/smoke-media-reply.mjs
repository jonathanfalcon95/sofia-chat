/**
 * Smoke checks for media reply wamid resolution (no network).
 * Run: node scripts/smoke-media-reply.mjs
 */

function messageWamid(m) {
  if (m.wamid) return m.wamid;
  if (m.ycloud_message_id?.startsWith("wamid.")) return m.ycloud_message_id;
  return null;
}

function resolveReplyToWamid(replyTo) {
  if (!replyTo) return null;
  return (
    replyTo.wamid ||
    (replyTo.ycloud_message_id?.startsWith("wamid.")
      ? replyTo.ycloud_message_id
      : null) ||
    null
  );
}

const cases = [
  {
    name: "inbound image with wamid column",
    msg: {
      type: "image",
      wamid: "wamid.ABC",
      ycloud_message_id: "6a78c0afce0c8f10c310b823",
    },
    expect: "wamid.ABC",
  },
  {
    name: "inbound document missing wamid (bug before backfill)",
    msg: {
      type: "document",
      wamid: null,
      ycloud_message_id: "6a78c0d336b44f08cf940786",
    },
    expect: null,
  },
  {
    name: "text with ycloud id as wamid",
    msg: {
      type: "text",
      wamid: null,
      ycloud_message_id: "wamid.TEXT123",
    },
    expect: "wamid.TEXT123",
  },
];

let failed = 0;
for (const c of cases) {
  const got = resolveReplyToWamid(c.msg);
  const ok = got === c.expect;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: got=${got} expect=${c.expect}`);
  if (!ok) failed += 1;
  const mw = messageWamid(c.msg);
  if (mw !== got && !(mw === null && got === null)) {
    // messageWamid and resolveReplyToWamid should agree
    console.log(`FAIL helper mismatch for ${c.name}: messageWamid=${mw}`);
    failed += 1;
  }
}

// Quote map lookup simulation
const media = {
  id: "1",
  type: "image",
  wamid: "wamid.IMG1",
  body: "Imagen",
};
const reply = {
  id: "2",
  type: "text",
  reply_to_wamid: "wamid.IMG1",
  body: "visto",
};
const byWamid = new Map([[messageWamid(media), media]]);
const quoted = byWamid.get(reply.reply_to_wamid);
const quoteOk = quoted?.type === "image";
console.log(`${quoteOk ? "PASS" : "FAIL"} quote lookup resolves image`);
if (!quoteOk) failed += 1;

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll smoke checks passed");
