import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (process.env.TRACE_FILE) appendFileSync(process.env.TRACE_FILE, `${r.url}\n`);
  return r;
}
