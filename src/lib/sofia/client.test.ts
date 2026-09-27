import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSofiaPauseFlags,
  sofiaApiBaseForAccountName,
  whitelistContactName,
} from "./routing.ts";

const YCLOUD_1 =
  "https://sofia-api-ycloud-dev.thankfulsky-d6ee3cbf.eastus.azurecontainerapps.io";
const YCLOUD_2 =
  "https://sofia-api-ycloud-global.thankfulsky-d6ee3cbf.eastus.azurecontainerapps.io";

test("sofia API base follows the YCloud account name", () => {
  delete process.env.SOFIA_API_BASE_YCLOUD_1;
  delete process.env.SOFIA_API_BASE_YCLOUD_2;
  assert.equal(sofiaApiBaseForAccountName(null), YCLOUD_1);
  assert.equal(sofiaApiBaseForAccountName("YCloud 1"), YCLOUD_1);
  assert.equal(sofiaApiBaseForAccountName("YCloud 2"), YCLOUD_2);
  assert.equal(sofiaApiBaseForAccountName("Otra cuenta"), YCLOUD_2);
});

test("parseSofiaPauseFlags reads line and chat flags", () => {
  assert.deepEqual(
    parseSofiaPauseFlags(
      { action: "status", linePaused: true, chatPaused: false, paused: false },
      "status",
    ),
    { linePaused: true, chatPaused: false },
  );
  assert.deepEqual(parseSofiaPauseFlags({ action: "stop", paused: true }, "stop"), {
    linePaused: null,
    chatPaused: true,
  });
  assert.deepEqual(
    parseSofiaPauseFlags({ action: "stop-all", paused: true }, "stop-all"),
    { linePaused: true, chatPaused: null },
  );
});

test("whitelistContactName falls back to the phone tail", () => {
  assert.equal(whitelistContactName("Ana", "584145678809"), "Ana");
  assert.equal(whitelistContactName("  ", "584145678809"), "User_678809");
});
