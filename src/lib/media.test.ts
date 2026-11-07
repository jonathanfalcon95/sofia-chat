import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_LIMITS, maxBytesForKind, mediaKindFromMime } from "./media.ts";

describe("maxBytesForKind", () => {
  test("a received sticker of about 1 MB fits", () => {
    assert.equal(mediaKindFromMime("image/webp"), "sticker");
    assert.ok(983 * 1024 <= maxBytesForKind("sticker", true));
  });

  test("a sticker to send keeps the WhatsApp limit", () => {
    assert.equal(maxBytesForKind("sticker"), MEDIA_LIMITS.sticker);
  });

  test("other kinds are unchanged", () => {
    assert.equal(maxBytesForKind("document", true), MEDIA_LIMITS.inboundDocument);
    assert.equal(maxBytesForKind("document"), MEDIA_LIMITS.document);
    assert.equal(maxBytesForKind("image", true), MEDIA_LIMITS.image);
    assert.equal(maxBytesForKind("video", true), MEDIA_LIMITS.video);
  });
});
