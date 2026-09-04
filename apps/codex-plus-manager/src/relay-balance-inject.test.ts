import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const script = readFileSync(
  new URL("../../../assets/inject/relay-balance-inject.js", import.meta.url),
  "utf8",
);

test("relay balance uses the protected backend bridge", () => {
  assert.match(script, /callBridge\("\/relay-balance\/query"/);
  assert.doesNotMatch(script, /Authorization\s*:/);
  assert.doesNotMatch(script, /apiKey/);
});

test("relay balance includes usage details and local display preferences", () => {
  assert.match(script, /model_stats/);
  assert.match(script, /cache_creation_tokens/);
  assert.match(script, /actual_cost/);
  assert.match(script, /refreshMinutes/);
  assert.match(script, /rangeDays/);
  assert.match(script, /\/v1\/usage/);
});
