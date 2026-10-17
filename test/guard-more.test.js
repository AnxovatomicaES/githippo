// Issue #6: more detectors, each with checks so ordinary text isn't blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scan } from "../src/guard.js";

const kinds = (t) => scan(t).map((f) => f.kind);

test("new detectors catch real formats", () => {
  assert.deepEqual(kinds("NI number AB 12 34 56 C"), ["uk_nino"]);
  assert.deepEqual(kinds("NIR 1 85 05 78 006 084 91"), ["french_nir"]);
  assert.deepEqual(kinds("key sk_live_" + "a1B2".repeat(6)), ["stripe_key"]);
  assert.deepEqual(kinds("whsec_" + "Z".repeat(30)), ["stripe_key"]);
  assert.deepEqual(kinds("AIza" + "B".repeat(35)), ["google_api_key"]);
  assert.deepEqual(kinds("SG." + "a".repeat(22) + "." + "b".repeat(43)), ["sendgrid_key"]);
  assert.deepEqual(kinds("npm_" + "c".repeat(36)), ["npm_token"]);
  assert.deepEqual(kinds("hf_" + "d".repeat(34)), ["huggingface_token"]);
});

test("look-alikes and ordinary text pass", () => {
  for (const t of [
    "Gate BG 12 34 56 A is closed",        // never-issued NINO prefix
    "Specimen QQ 12 34 56 C from HMRC docs", // Q is never issued as a first letter
    "Flight QQ123456C lands at 9",         // too short to be a NINO? (8 chars) — not matched
    "Ticket 1 85 05 78 006 084 12",        // NIR with a wrong key
    "Use pk_test in the docs example",     // no key body
    "The AIza prefix marks Google keys",   // prefix only
    "Order SG.12 shipped",                 // not a SendGrid key
    "npm_install is a function name",      // not 36 chars
  ]) assert.deepEqual(kinds(t), [], t);
});
