import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPreferredCompanyId } from "./inbox-company-preference.ts";

test("pickPreferredCompanyId accepts a company the user can see", () => {
  const companies = [
    { id: "aaa" },
    { id: "e52ca65d-d58b-4973-860f-25086ff309a9" },
  ];
  assert.equal(
    pickPreferredCompanyId(companies, "e52ca65d-d58b-4973-860f-25086ff309a9"),
    "e52ca65d-d58b-4973-860f-25086ff309a9",
  );
});

test("pickPreferredCompanyId ignores unknown or empty preferences", () => {
  const companies = [{ id: "aaa" }];
  assert.equal(pickPreferredCompanyId(companies, "zzz"), null);
  assert.equal(pickPreferredCompanyId(companies, ""), null);
  assert.equal(pickPreferredCompanyId(companies, null), null);
});
