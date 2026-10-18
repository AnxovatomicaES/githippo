// Threshold calibration for an embedder: cosine ranges for duplicate / updated / same-topic / unrelated pairs
// (same method as docs/calibration.md). Usage: EMBEDDINGS=static node eval/calibrate.js
import { createEmbedder, cosine } from "../src/embed.js";
const sets = {
  duplicate: [["Sam owns the billing rewrite", "The billing rewrite is owned by Sam"], ["Johnny needs a wake word and runs locally on the Mac mini", "Johnny runs locally on the Mac mini and needs a wake word"], ["Newsletter goes out every Monday at 8am", "The newsletter is sent each Monday at 8am"], ["Prefers concise answers with code first", "Prefers concise answers, code first"], ["Marcel is based in Spain", "Marcel lives in Spain"], ["Use a 16 kHz sample rate", "The sample rate is 16 kHz"]],
  updated: [["Launch target is end of Q1", "Launch target is end of Q2"], ["Primary brand colour is navy", "Primary brand colour is teal"], ["Sam owns the billing rewrite", "Priya owns the billing rewrite"], ["Newsletter goes out every Monday at 8am", "Newsletter goes out every Tuesday at 9am"], ["Use a 16 kHz sample rate", "Use a 48 kHz sample rate"], ["The team uses Postgres for billing", "The team moved billing to MySQL"]],
  same_topic: [["Sam owns the billing rewrite", "Billing v2 uses idempotency keys"], ["Johnny needs a wake word", "Johnny should support Spanish and English"], ["Primary brand colour is navy", "Logo is a lighthouse"], ["Newsletter goes out every Monday", "Newsletter has a markets section"]],
  unrelated: [["Sam owns the billing rewrite", "Primary brand colour is navy"], ["Johnny needs a wake word", "Launch target is end of Q1"], ["Use a 16 kHz sample rate", "The CTO is based in Spain"], ["Prefers RFCs over meetings", "Newsletter goes out every Monday"], ["Marcel is based in Spain", "Use idempotency keys on every write endpoint"]],
};
const emb = createEmbedder(process.env);
const out = [`calibration · ${emb.id}`];
for (const [name, pairs] of Object.entries(sets)) {
  const sims = [];
  for (const [a, b] of pairs) {
    const [va, vb] = await emb.embed([a, b], "document");
    sims.push(cosine(va, vb));
  }
  sims.sort((x, y) => x - y);
  out.push(`${name.padEnd(11)} ${sims[0].toFixed(2)} – ${sims.at(-1).toFixed(2)}  [${sims.map((s) => s.toFixed(2)).join(" ")}]`);
}
emb.stop?.();
console.log(out.join("\n"));
