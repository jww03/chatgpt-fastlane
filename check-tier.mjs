#!/usr/bin/env node
// check-tier.mjs — print the service tier the Codex engine used for the latest turns, from the
// engine's own log database (%USERPROFILE%\.codex\logs_2.sqlite, read-only). Node 22.5+ (node:sqlite).
// Usage: node check-tier.mjs [hours]   (default 3)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const hours = Number(process.argv[2] ?? 3);
const db = new DatabaseSync(path.join(process.env.USERPROFILE, ".codex", "logs_2.sqlite"), { readOnly: true });
const since = Math.floor(Date.now() / 1000) - hours * 3600;
const rows = db.prepare("select ts, process_uuid, feedback_log_body as b from logs where ts > ? and feedback_log_body like '%service_tier%' order by ts").all(since);
const seen = new Set();
console.log(`turns in the last ${hours} h (time, thread, model, service_tier, engine pid):`);
for (const r of rows) {
  const t = new Date(r.ts * 1000).toLocaleTimeString("en-GB");
  const thread = (r.b.match(/thread_id=([0-9a-f-]{8})/) || [])[1] || "-";
  const model = (r.b.match(/ model=([^ }]+)/) || [])[1] || "-";
  const tier = (r.b.match(/service_tier[=:"]+\s*"?([^",} ]*)/) || [])[1] || "(none)";
  const key = t + thread + model + tier;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${t}  ${thread}  ${model.padEnd(14)}  ${tier.padEnd(10)}  ${r.process_uuid.slice(0, 10)}`);
}
if (!rows.length) console.log("  (none)");
