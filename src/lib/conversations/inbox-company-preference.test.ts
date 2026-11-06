import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickPreferredCompanyId,
  resolveInitialCompanyId,
} from "./inbox-company-preference.ts";

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

test("resolveInitialCompanyId scopes single-company users without a cookie", () => {
  assert.equal(resolveInitialCompanyId([{ id: "aaa" }], undefined), "aaa");
});

test("resolveInitialCompanyId honors a valid preference and ignores a stale one", () => {
  const companies = [{ id: "aaa" }, { id: "bbb" }];
  assert.equal(resolveInitialCompanyId(companies, "bbb"), "bbb");
  assert.equal(resolveInitialCompanyId(companies, "zzz"), "aaa");
});

test("resolveInitialCompanyId is empty only when the user has no company", () => {
  assert.equal(resolveInitialCompanyId([], "aaa"), "");
});
