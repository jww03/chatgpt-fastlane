#!/usr/bin/env node
// patch-codex-speed.mjs — build a patched copy of the Codex desktop app (Windows, Electron/"owl" runtime)
// in which the Speed (Fast / Ultrafast) controls are shown and honoured for a custom model provider.
//
// It never writes into the installed package. It reads the installed app, writes a patched
// `resources/app.asar` plus a `ChatGPT.exe` whose embedded asar-integrity hash is updated, and
// (with --full-copy) copies the rest of the app folder next to them so the copy can be launched.
//
// Re-applyable across app updates:
//   * the installed package is located with Get-AppxPackage (no hard-coded version),
//   * the four gates are matched by their stable string literals (`chatgpt`, `personalAccessToken`,
//     `amazonBedrock`, `.serviceTier`), with the minified identifiers as wildcards, across every JS bundle,
//   * each gate must match exactly once or the build aborts and tells you which gate changed,
//   * output goes to build\<installed version>\app, so an update simply produces a new folder.
//
// Usage (the .cmd files next to this script wrap the common combinations):
//   node patch-codex-speed.mjs                       # dry run: patched app.asar + ChatGPT.exe into build\<ver>\app
//   node patch-codex-speed.mjs --full-copy           # also copy the rest of the app (~2 GB) so the copy can run
//   node patch-codex-speed.mjs --full-copy --if-needed --launch
//                                                    # launch.cmd: build only if this version is not built yet
//                                                    # (or fails verification), then start the copy
//   node patch-codex-speed.mjs --store-update --full-copy --if-needed --launch
//                                                    # update.cmd: let the Microsoft Store update the app first (winget),
//                                                    # then build the new version if needed and start it
//   node patch-codex-speed.mjs --shortcut            # shortcut.cmd: Start-menu entry "Codex Fastlane" -> launch.cmd
//   node patch-codex-speed.mjs --status              # status.cmd: installed version, builds, what is running
//   node patch-codex-speed.mjs --prune               # cleanup.cmd: delete builds of other versions (never a running one)
//   node patch-codex-speed.mjs --verify-only         # re-verify build\<ver>\app
//   options: --src <installed app folder>  --out <output app folder>
//
// Requirements: Node 18+ (tested with Node 24). No npm packages; the asar reader/writer is inline.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

// ---------------------------------------------------------------------------------------------
// The patch. Each gate is a regex whose literals are the stable parts of the app's source; the
// minified identifiers are wildcards with back-references. `apply` turns the match into the patched text.
// ---------------------------------------------------------------------------------------------
const ID = "[A-Za-z_$][\\w$]*";
const GATES = [
  {
    id: "G1 UI hook (serviceTierAccess): grant access for every auth method",
    // a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,
    re: new RegExp("(=)(" + ID + ")(\\?\\.authMethod===`chatgpt`(?:\\|\\|\\2\\?\\.authMethod===`[A-Za-z]+`)+),", "g"),
    apply: (m) => m.replace(/^=/, "=!0||"),
  },
  {
    id: "G2 request-time resolver: do not return null for other auth methods",
    // if(n!==`chatgpt`&&n!==`personalAccessToken`&&n!==`amazonBedrock`)return null;
    re: new RegExp("if\\((" + ID + ")!==`chatgpt`(?:&&\\1!==`[A-Za-z]+`)+\\)return null;", "g"),
    apply: () => "if(!1)return null;",
  },
  {
    id: "G3 turn prepare: keep submissionOptions.serviceTier for any account type",
    // return t?.type===`chatgpt`||t?.type===`amazonBedrock`?u.serviceTier:null
    re: new RegExp("return (" + ID + ")\\?\\.type===`chatgpt`(?:\\|\\|\\1\\?\\.type===`[A-Za-z]+`)+\\?(" + ID + ")\\.serviceTier:null", "g"),
    apply: (m) => m.replace(/^return /, "return !0||"),
  },
  {
    id: "G4 default turn config (readServiceTier): allow reading the saved tier for any account type",
    // return n.account?.type===`chatgpt`||n.account?.type===`amazonBedrock`})
    re: new RegExp("return (" + ID + ")\\.account\\?\\.type===`chatgpt`(?:\\|\\|\\1\\.account\\?\\.type===`[A-Za-z]+`)+\\}\\)", "g"),
    apply: (m) => m.replace(/^return /, "return !0||"),
  },
];
const CANDIDATE_FILES = (p) => /^webview\/assets\/.*\.js$/.test(p) || /^\.vite\/build\/.*\.js$/.test(p);

const INTEGRITY_RE = /\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/g;
const BLOCK_SIZE = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// locate the installed app
// ---------------------------------------------------------------------------------------------
function findInstalledApp() {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", windowsHide: true }).trim();
    if (out && fs.existsSync(path.join(out, "app", "ChatGPT.exe"))) return path.join(out, "app");
  } catch { /* fall through */ }
  const root = "C:\\Program Files\\WindowsApps";
  try {
    const dirs = fs.readdirSync(root).filter((d) => /^OpenAI\.Codex_\d/.test(d) && /_x64__/.test(d)).sort();
    if (dirs.length) return path.join(root, dirs[dirs.length - 1], "app");
  } catch { /* fall through */ }
  throw new Error("Codex Store package not found; pass --src <...\\app>");
}

function appVersion(src) {
  const m = src.match(/OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_/);
  if (m) return m[1];
  try { const ini = fs.readFileSync(path.join(src, "resources", "owl-app.ini"), "utf8"); const v = ini.match(/AppVersion=([\d.]+)/); if (v) return v[1]; } catch { /* ignore */ }
  return "unknown";
}

// Microsoft Store product id of the Codex package (family OpenAI.Codex_2p2nqsd0c76g0), from
// `winget search OpenAI --source msstore`. The Store lists it under the name "ChatGPT".
const STORE_ID = "9PLM9XGG6VKS";

function installedVersion() {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1).Version"],
      { encoding: "utf8", windowsHide: true }).trim();
  } catch { return ""; }
}

// Ask the Microsoft Store (through winget's msstore source) to install the current version of the
// package. Nothing in this folder is touched; only the Store package changes, exactly as a normal
// Store update would. Returns the version before and after.
function storeUpdate() {
  const before = installedVersion();
  console.log(`Installed Store version: ${before || "(none)"}. Asking the Microsoft Store for an update (winget, product ${STORE_ID})...`);
  const r = spawnSync("winget", ["upgrade", "--id", STORE_ID, "--source", "msstore",
    "--accept-source-agreements", "--accept-package-agreements"], { stdio: "inherit", windowsHide: true });
  const after = installedVersion();
  if (r.error) console.log(`winget could not run (${r.error.message}); open the Microsoft Store > Library > Get updates instead.`);
  if (after && before && after !== before) console.log(`Store app updated: ${before} -> ${after}`);
  else if (r.status === 0x8A15002B || r.status === -1978335189) console.log(`Store app unchanged (${after || before}): the Store has no newer version.`);
  else console.log(`Store app unchanged (${after || before || "not installed"}).${r.status ? " winget exit code " + r.status + "; see its output above." : ""}`);
  return { before, after, winget: r.status ?? null };
}

if (flag("--store-update")) storeUpdate();

const SRC = opt("--src", null) ?? findInstalledApp();
const VERSION = appVersion(SRC);
const OUT = opt("--out", path.join(HERE, "build", VERSION, "app"));
const FULL_COPY = flag("--full-copy");
const VERIFY_ONLY = flag("--verify-only");
const IF_NEEDED = flag("--if-needed");
const LAUNCH = flag("--launch");
const STATUS = flag("--status");
const PRUNE = flag("--prune");
const SHORTCUT = flag("--shortcut");

// Start-menu entry "Codex Fastlane": a shortcut to launch.cmd (minimised console while it builds or starts)
// with assets\codex-fastlane.ico and the app's AppUserModelID, written by shortcut.ps1. The patched copy
// has no icon of its own (Store apps keep theirs in the package manifest), so the taskbar shows a blank
// page unless this entry is pinned there. Remove it by deleting the .lnk.
const SHORTCUT_NAME = "Codex Fastlane";
function shortcutPath() {
  return path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", SHORTCUT_NAME + ".lnk");
}
function installShortcut() {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(HERE, "shortcut.ps1"), "-Lnk", shortcutPath()], { encoding: "utf8", windowsHide: true });
  console.log(out.trim());
  return shortcutPath();
}

// ---------------------------------------------------------------------------------------------
// asar helpers (format: [u32 4][u32 headerPickleLen][u32 4+paddedJson][u32 jsonLen][json padded to 4][data...])
// ---------------------------------------------------------------------------------------------
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const h = Buffer.alloc(16);
  fs.readSync(fd, h, 0, 16, 0);
  if (h.readUInt32LE(0) !== 4) throw new Error("not an asar: " + asarPath);
  const headerPickleLen = h.readUInt32LE(4);
  const jsonLen = h.readUInt32LE(12);
  const json = Buffer.alloc(jsonLen);
  fs.readSync(fd, json, 0, jsonLen, 16);
  return { fd, header: JSON.parse(json.toString("utf8")), json, dataBase: 8 + headerPickleLen };
}

function buildAsarPrefix(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const buf = Buffer.alloc(16 + padded);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(8 + padded, 4);
  buf.writeUInt32LE(4 + padded, 8);
  buf.writeUInt32LE(json.length, 12);
  json.copy(buf, 16);
  return { prefix: buf, json };
}

function* walk(node, prefix = "") {
  for (const [name, entry] of Object.entries(node.files)) {
    if (entry.files) yield* walk(entry, prefix + name + "/");
    else yield [prefix + name, entry];
  }
}

function getEntry(header, p) {
  let n = header;
  for (const part of p.split("/")) n = n.files[part];
  return n;
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function integrityOf(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) blocks.push(sha256(buf.subarray(i, Math.min(buf.length, i + BLOCK_SIZE))));
  return { algorithm: "SHA256", hash: sha256(buf), blockSize: BLOCK_SIZE, blocks };
}

function readEntry(fd, dataBase, entry) {
  const buf = Buffer.alloc(entry.size);
  if (entry.size > 0) fs.readSync(fd, buf, 0, entry.size, dataBase + Number(entry.offset));
  return buf;
}

// ---------------------------------------------------------------------------------------------
// find and apply the gates across all JS bundles
// ---------------------------------------------------------------------------------------------
function locateGates(fd, header, dataBase) {
  const hits = GATES.map(() => []); // per gate: [{file, index, match}]
  const texts = new Map();
  for (const [p, e] of walk(header)) {
    if (!CANDIDATE_FILES(p) || e.unpacked || e.size < 1000) continue;
    const text = readEntry(fd, dataBase, e).toString("utf8");
    let used = false;
    GATES.forEach((g, i) => {
      g.re.lastIndex = 0;
      let m;
      while ((m = g.re.exec(text))) { hits[i].push({ file: p, index: m.index, match: m[0] }); used = true; }
    });
    if (used) texts.set(p, text);
  }
  const problems = [];
  hits.forEach((h, i) => { if (h.length !== 1) problems.push(`${GATES[i].id}: ${h.length} match(es)` + h.map((x) => ` [${x.file} @${x.index}]`).join("")); });
  if (problems.length) throw new Error("The app's code changed; gates could not be matched exactly once:\n  " + problems.join("\n  ") + "\nRe-derive the patterns for this version (see README section 2).");
  return { hits: hits.map((h) => h[0]), texts };
}

function buildPatchedAsar(srcAsar, outAsar) {
  const { fd, header, json: oldJson, dataBase } = readAsarHeader(srcAsar);
  const report = { srcAsar, outAsar, oldHeaderSha256: sha256(oldJson), patched: [] };

  const { hits, texts } = locateGates(fd, header, dataBase);
  const patchedBytes = new Map();
  for (const [file, text] of texts) {
    let t = text;
    GATES.forEach((g, i) => {
      const h = hits[i];
      if (h.file !== file) return;
      const before = t.length;
      t = t.replace(h.match, () => g.apply(h.match));
      report.patched.push({ file, id: g.id, offset: h.index, matched: h.match.slice(0, 120), delta: t.length - before });
    });
    patchedBytes.set(file, Buffer.from(t, "utf8"));
  }

  // new header: same tree, new offsets (and new size/integrity for patched files); identical files stored once
  const newHeader = structuredClone(header);
  let offset = 0;
  const plan = [];
  const seen = new Map();
  for (const [p, e] of walk(newHeader)) {
    if (e.unpacked) continue;
    const bytes = patchedBytes.get(p) ?? null;
    const srcEntry = getEntry(header, p);
    if (bytes) { e.size = bytes.length; e.integrity = integrityOf(bytes); }
    else if (seen.has(srcEntry.offset)) { e.offset = seen.get(srcEntry.offset); continue; }
    e.offset = String(offset);
    if (!bytes) seen.set(srcEntry.offset, e.offset);
    plan.push([p, e, bytes ? null : dataBase + Number(srcEntry.offset), bytes]);
    offset += e.size;
  }

  const { prefix, json: newJson } = buildAsarPrefix(newHeader);
  fs.mkdirSync(path.dirname(outAsar), { recursive: true });
  const out = fs.openSync(outAsar, "w");
  fs.writeSync(out, prefix, 0, prefix.length, 0);
  let pos = prefix.length;
  const chunk = Buffer.alloc(16 * 1024 * 1024);
  for (const [, e, srcOff, bytes] of plan) {
    if (bytes) { fs.writeSync(out, bytes, 0, bytes.length, pos); pos += bytes.length; continue; }
    let left = e.size, from = srcOff;
    while (left > 0) {
      const n = fs.readSync(fd, chunk, 0, Math.min(left, chunk.length), from);
      if (n <= 0) throw new Error("short read in " + srcAsar);
      fs.writeSync(out, chunk, 0, n, pos);
      pos += n; from += n; left -= n;
    }
  }
  fs.closeSync(out);
  fs.closeSync(fd);
  report.newHeaderSha256 = sha256(newJson);
  report.outSize = pos;
  report.patchedFiles = [...patchedBytes.keys()];
  return report;
}

function buildPatchedExe(srcExe, outExe, oldHash, newHash) {
  const buf = fs.readFileSync(srcExe);
  const text = buf.toString("latin1");
  const hits = [...text.matchAll(INTEGRITY_RE)];
  if (hits.length !== 1) throw new Error(`expected exactly 1 ElectronAsar integrity resource in ${srcExe}, found ${hits.length}`);
  if (hits[0][1] !== oldHash) throw new Error(`integrity resource hash ${hits[0][1]} does not match the installed app.asar header hash ${oldHash}`);
  const at = hits[0].index + hits[0][0].indexOf(oldHash);
  buf.write(newHash, at, 64, "latin1");
  fs.mkdirSync(path.dirname(outExe), { recursive: true });
  fs.writeFileSync(outExe, buf);
  return { srcExe, outExe, resourceOffset: at, oldHash, newHash };
}

function copyRestOfApp(src, out) {
  const skip = new Set([path.join(src, "ChatGPT.exe").toLowerCase(), path.join(src, "resources", "app.asar").toLowerCase()]);
  fs.cpSync(src, out, { recursive: true, force: true, errorOnExist: false, filter: (s) => !skip.has(s.toLowerCase()) });
}

function verify(outDir) {
  const asarPath = path.join(outDir, "resources", "app.asar");
  const exePath = path.join(outDir, "ChatGPT.exe");
  if (!fs.existsSync(asarPath) || !fs.existsSync(exePath)) return { ok: false, reason: "not built" };
  const { fd, header, json, dataBase } = readAsarHeader(asarPath);
  const headerHash = sha256(json);
  const exeText = fs.readFileSync(exePath).toString("latin1");
  const hits = [...exeText.matchAll(INTEGRITY_RE)];
  const result = { asarPath, exePath, headerHash, exeHash: hits[0]?.[1] ?? null, exeHashMatches: hits.length === 1 && hits[0][1] === headerHash, gates: [], sampleIntegrityOk: 0, sampleIntegrityBad: [] };
  // every gate must now be absent in its original form and present in patched form, across the candidate files
  const patchedForms = [/=!0\|\|[A-Za-z_$][\w$]*\?\.authMethod===`chatgpt`/, /if\(!1\)return null;let [A-Za-z_$][\w$]* ?= ?await/, /return !0\|\|[A-Za-z_$][\w$]*\?\.type===`chatgpt`/, /return !0\|\|[A-Za-z_$][\w$]*\.account\?\.type===`chatgpt`/];
  const found = GATES.map(() => ({ original: 0, patched: 0, integrityOk: true }));
  for (const [p, e] of walk(header)) {
    if (!CANDIDATE_FILES(p) || e.unpacked || e.size < 1000) continue;
    const buf = readEntry(fd, dataBase, e);
    const text = buf.toString("utf8");
    let touched = false;
    GATES.forEach((g, i) => { g.re.lastIndex = 0; if (g.re.test(text)) found[i].original++; if (patchedForms[i].test(text)) { found[i].patched++; touched = true; } });
    if (touched) { const integ = integrityOf(buf); const ok = integ.hash === e.integrity.hash && JSON.stringify(integ.blocks) === JSON.stringify(e.integrity.blocks); if (!ok) found.forEach((f) => (f.integrityOk = false)); }
  }
  result.gates = GATES.map((g, i) => ({ id: g.id, originalAbsent: found[i].original === 0, patchedPresent: found[i].patched === 1, integrityOk: found[i].integrityOk }));
  const all = [...walk(header)].filter(([, e]) => !e.unpacked);
  const sample = new Set([0, all.length - 1, all.reduce((m, [, e], i) => (e.size > all[m][1].size ? i : m), 0)]);
  for (let i = 0; i < all.length; i += 500) sample.add(i);
  for (const i of sample) {
    const [p, e] = all[i];
    const ok = sha256(readEntry(fd, dataBase, e)) === e.integrity.hash;
    if (ok) result.sampleIntegrityOk++; else result.sampleIntegrityBad.push(p);
  }
  fs.closeSync(fd);
  result.fullCopyPresent = fs.existsSync(path.join(outDir, "chrome.dll")) && fs.existsSync(path.join(outDir, "resources", "codex.exe"));
  result.ok = result.exeHashMatches && result.gates.every((g) => g.originalAbsent && g.patchedPresent && g.integrityOk) && result.sampleIntegrityBad.length === 0;
  return result;
}

// ---------------------------------------------------------------------------------------------
// launching
// ---------------------------------------------------------------------------------------------
function runningChatGPT() {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"], { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function launch(outDir) {
  const running = runningChatGPT();
  const store = running.filter((p) => /\\WindowsApps\\/i.test(p));
  const mine = running.filter((p) => p.toLowerCase().startsWith(path.resolve(outDir).toLowerCase()));
  const other = running.filter((p) => !store.includes(p) && !mine.includes(p));
  if (store.length) { console.log("The Store app is running (" + store[0] + "). Quit it first (tray icon too), then run this again."); return 2; }
  if (mine.length) { console.log("The patched copy for this version is already running."); return 0; }
  if (other.length) { console.log("Another Codex copy is running: " + other[0] + ". Quit it first."); return 2; }
  const exe = path.join(outDir, "ChatGPT.exe");
  const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: outDir, windowsHide: false });
  child.unref();
  console.log(`Launched ${exe} (pid ${child.pid})`);
  return 0;
}

// Build folders under build\: either build\<version>\app (current layout) or build\app (the first,
// unversioned build from 2026-10-30). Returns {name, dir, app, version, report, running}.
function listBuilds() {
  const buildRoot = path.join(HERE, "build");
  if (!fs.existsSync(buildRoot)) return [];
  const running = runningChatGPT().map((p) => p.toLowerCase());
  const builds = [];
  for (const d of fs.readdirSync(buildRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(buildRoot, d.name);
    const legacy = d.name === "app";
    const app = legacy ? dir : path.join(dir, "app");
    if (!fs.existsSync(path.join(app, "ChatGPT.exe"))) continue;
    let report = null;
    try { report = JSON.parse(fs.readFileSync(legacy ? path.join(buildRoot, "report.json") : path.join(dir, "report.json"), "utf8")); } catch { /* none */ }
    const version = legacy ? (report?.version ?? appVersion(report?.src ?? "")) : d.name;
    const isRunning = running.some((p) => p.startsWith(app.toLowerCase() + path.sep.toLowerCase()) || p.startsWith(app.toLowerCase() + "\\"));
    builds.push({ name: d.name, dir, app, version, legacy, report, running: isRunning });
  }
  return builds;
}

function status() {
  console.log(`Installed Store app: ${SRC}\n  version ${VERSION}`);
  const running = runningChatGPT();
  console.log(running.length ? `Running: ${running.join(", ")}` : "Running: nothing");
  const builds = listBuilds();
  console.log(builds.length ? "Builds in build\\:" : "Builds in build\\: none");
  for (const b of builds) {
    const v = b.report?.verify;
    const state = !v ? "no report" : !v.ok ? "FAILED verification" : v.fullCopyPresent ? "verified, launchable" : "verified, dry run only";
    const flags = [b.version === VERSION ? "current" : "old version", b.running ? "RUNNING" : null, b.legacy ? "unversioned layout" : null].filter(Boolean).join(", ");
    console.log(`  ${b.name.padEnd(16)} version ${String(b.version).padEnd(15)} ${state}  [${flags}]`);
  }
  const cur = builds.find((b) => b.version === VERSION && b.report?.verify?.ok && b.report.verify.fullCopyPresent);
  console.log(cur ? `The installed version is built: ${cur.app}` : `The installed version ${VERSION} is not built yet: run patch.cmd or launch.cmd.`);
  const stale = builds.filter((b) => b.version !== VERSION || (b.legacy && builds.some((o) => !o.legacy && o.version === VERSION)));
  if (stale.length) console.log(`Old builds that cleanup.cmd would delete: ${stale.map((b) => b.name + (b.running ? " (running now, kept until quit)" : "")).join(", ")}`);
}

// fs.rmSync failed with EPERM on a copied app folder (2026-11-03: no read-only files, nothing running,
// 3841 items; `rm -rf` and `rmdir /s /q` delete it fine). So: try Node, then fall back to cmd's rmdir.
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
    console.log(`  Node could not delete it (${e.code}); using rmdir /s /q instead.`);
    const r = spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", dir], { stdio: "inherit", windowsHide: true });
    if (fs.existsSync(dir)) throw new Error(`could not delete ${dir} (rmdir exit ${r.status}); check for open files and delete it by hand`);
  }
}

// Delete builds of other versions. A build whose ChatGPT.exe is running is kept. The build of the
// installed version is always kept; the unversioned build\app is deleted only once a versioned build
// of the same version exists, so there is always one launchable copy left.
function prune() {
  const builds = listBuilds();
  const hasVersioned = builds.some((b) => !b.legacy && b.version === VERSION && b.report?.verify?.ok);
  let removed = 0;
  for (const b of builds) {
    const stale = b.version !== VERSION || (b.legacy && hasVersioned);
    if (!stale) continue;
    if (b.running) { console.log(`Keeping ${b.dir}: a Codex copy is running from it. Quit it and run cleanup.cmd again.`); continue; }
    console.log(`Deleting ${b.dir} (version ${b.version})...`);
    removeTree(b.dir);
    if (b.legacy) fs.rmSync(path.join(HERE, "build", "report.json"), { force: true });
    removed++;
  }
  console.log(removed ? `Deleted ${removed} old build(s).` : "Nothing to delete.");
}

// ---------------------------------------------------------------------------------------------
(function main() {
  if (STATUS) { status(); return; }
  if (PRUNE) { prune(); return; }
  if (SHORTCUT && !LAUNCH) { installShortcut(); return; }
  const report = { date: new Date().toISOString(), src: SRC, version: VERSION, out: OUT };
  const reportPath = path.join(path.dirname(OUT), "report.json");
  console.log(`Installed app: ${SRC} (version ${VERSION})`);
  console.log(`Build folder:  ${OUT}`);
  let needBuild = !VERIFY_ONLY;
  if (IF_NEEDED && !VERIFY_ONLY) {
    const v = verify(OUT);
    if (v.ok && (!FULL_COPY || v.fullCopyPresent)) { console.log("Already built and verified for this version; skipping the build."); needBuild = false; report.verify = v; }
    else console.log("No valid build for this version yet (" + (v.reason ?? "verification failed") + "); building.");
  }
  if (needBuild) {
    if (path.resolve(OUT).toLowerCase().startsWith(path.resolve(SRC).toLowerCase())) throw new Error("refusing to write inside the installed app folder");
    report.asar = buildPatchedAsar(path.join(SRC, "resources", "app.asar"), path.join(OUT, "resources", "app.asar"));
    for (const p of report.asar.patched) console.log(`  ${p.id}\n     ${p.file} @${p.offset}: ${p.matched}${p.matched.length >= 120 ? "…" : ""}`);
    console.log(`Wrote patched app.asar (${report.asar.outSize} bytes); header hash ${report.asar.oldHeaderSha256.slice(0, 12)}… -> ${report.asar.newHeaderSha256.slice(0, 12)}…`);
    report.exe = buildPatchedExe(path.join(SRC, "ChatGPT.exe"), path.join(OUT, "ChatGPT.exe"), report.asar.oldHeaderSha256, report.asar.newHeaderSha256);
    console.log(`Wrote ChatGPT.exe with the integrity resource updated at file offset ${report.exe.resourceOffset}`);
    if (FULL_COPY) { console.log("Copying the rest of the app folder (~2 GB)..."); copyRestOfApp(SRC, OUT); }
  }
  if (!report.verify) report.verify = verify(OUT);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.verify, null, 2));
  console.log(report.verify.ok ? `OK — verified. Report: ${reportPath}` : `FAILED verification. Report: ${reportPath}`);
  if (!report.verify.ok) process.exit(1);
  if (!report.verify.fullCopyPresent) console.log("Note: only app.asar and ChatGPT.exe are in the build folder (dry run). Run with --full-copy to make it launchable.");
  if (LAUNCH) {
    if (!report.verify.fullCopyPresent) { console.log("Cannot launch: not a full copy."); process.exit(1); }
    const rc = launch(OUT);
    if (SHORTCUT && rc === 0) { try { installShortcut(); } catch (e) { console.log("Could not write the Start-menu entry: " + e.message); } }
    process.exit(rc);
  }
})();
