// Found by reading OpenClaw's and Hermes's search code (both use trigram tokenizers): Chinese, Japanese and Thai
// text was one token per sentence, and accent stripping deleted Japanese voicing marks and Thai tone marks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, fold } from "../src/search.js";
import { InMemoryStore } from "../src/memstore.js";
import { MemoryIndex } from "../src/search.js";
import { Brain } from "../src/brain.js";

test("Chinese, Japanese and Thai are indexed as character bigrams", () => {
  assert.deepEqual(tokenize("支付团队"), ["支付", "付团", "团队"]);
  assert.deepEqual(tokenize("リーダー"), ["リー", "ーダ", "ダー"], "katakana long-vowel mark and voicing kept");
  assert.ok(tokenize("ทีมชำระเงิน").includes("ที"), "Thai vowel mark kept");
  assert.deepEqual(tokenize("使用 Postgres 16 数据库"), ["使用", "postgre", "16", "数据", "据库"], "mixed scripts (Latin part keeps the existing plural folding, same on both sides)");
});

test("accents are still folded where that's safe, and only there", () => {
  assert.deepEqual(tokenize("Café Münster"), ["cafe", "munster"]);
  assert.equal(fold("άλφα"), "αλφα", "Greek tonos");
  assert.equal(fold("ダ"), "ダ", "Japanese voicing survives");
  assert.equal(fold("й"), "й", "Cyrillic short-i is a different letter, not an accent");
  assert.deepEqual(tokenize("handleRefund src/api/wake.ts").slice(0, 3), ["handlerefund", "handle", "refund"], "code-aware splitting unchanged");
});

test("keyword-only recall finds Chinese notes by partial queries", async () => {
  const store = new InMemoryStore();
  await store.write("people/wang.md", "---\nname: wang\ntitle: Wang Wei\ndescription: Payments lead\n---\n\n- 王伟是支付团队的负责人\n- 他喜欢书面设计文档\n", "new");
  await store.write("topics/other.md", "---\nname: other\n---\n\n- Launch is end of Q2\n- 数据库迁移计划在十一月\n", "new");
  const brain = new Brain({ store, index: new MemoryIndex(store, null, {}) });
  for (const [q, want] of [["支付团队", "people/wang.md"], ["负责人", "people/wang.md"], ["谁负责支付", "people/wang.md"], ["数据库迁移", "topics/other.md"]]) {
    const r = await brain.recall(q, { mode: "brief" });
    assert.match(r.hits[0]?.ref || "none", new RegExp(`^${want.replace("/", "\\/")}`), q);
  }
});
