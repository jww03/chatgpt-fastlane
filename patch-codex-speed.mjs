#!/usr/bin/env node
// patch-codex-speed.mjs — build a patched copy of the Codex desktop app (Windows and macOS, Electron/"owl"
// runtime) in which the Speed (Fast / Ultrafast) controls are shown and honoured for a custom model provider.
//
// It never writes into the installed app. Windows: it reads the Store package, writes a patched
// `resources/app.asar` plus a `ChatGPT.exe` whose embedded asar-integrity hash is updated, and
// (with --full-copy) copies the rest of the app folder next to them so the copy can be launched.
// macOS: it clones /Applications/ChatGPT.app (APFS clone, almost no disk), writes the patched
// `Contents/Resources/app.asar`, updates the integrity hash in `Info.plist` and the pin in the
// framework's `__asar_integrity` section, gives the copy its own bundle id and re-signs it ad hoc.
//
// Re-applyable across app updates:
//   * the installed app is located with Get-AppxPackage / in /Applications (no hard-coded version),
//   * the four gates are matched by their stable string literals (`chatgpt`, `personalAccessToken`,
//     `amazonBedrock`, `.serviceTier`), with the minified identifiers as wildcards, across every JS bundle,
//   * each gate must match exactly once or the build aborts and tells you which gate changed,
//   * output goes to build\<installed version>\app (macOS: build/<version>/ChatGPT Fastlane.app), so an
//     update simply produces a new folder.
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
//   node patch-codex-speed.mjs --shortcut            # shortcut.cmd: Start-menu entry "ChatGPT Fastlane" -> launch.cmd
//   node patch-codex-speed.mjs --status              # status.cmd: installed version, builds, what is running
//   node patch-codex-speed.mjs --prune               # cleanup.cmd: delete builds of other versions (never a running one)
//   node patch-codex-speed.mjs --verify-only         # re-verify build\<ver>\app
//   options: --src <installed app folder>  --out <output app folder>   (macOS: the .app bundles)
// Live mode (official app patched in memory, no file written; see "Live mode" below): what --launch does on macOS
// (the build flags are ignored then; --copy builds and starts the patched copy instead). On Windows experimental:
//   node patch-codex-speed.mjs --launch --live [--gui]
// --live-helper is internal.
//
// Requirements: Node 18+ (tested with Node 24). No npm packages; the asar reader/writer is inline.
// macOS also uses the system's plutil, codesign, cp, ps and osascript.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const MAC = process.platform === "darwin";

// Everything printed also goes to build\launch.log, so a run started from the Start menu (whose console
// closes by itself) can be read afterwards.
const LOG = path.join(HERE, "build", "launch.log");
try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `\n=== ${new Date().toISOString()} ${process.argv.slice(2).join(" ")}\n`);
  for (const k of ["log", "error", "warn"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { orig(...a); try { fs.appendFileSync(LOG, a.map(String).join(" ") + "\n"); } catch { /* ignore */ } };
  }
  process.on("uncaughtException", (e) => { console.error("ERROR " + (e.stack || e)); if (args.includes("--gui")) popup("ChatGPT Fastlane could not build or start the patched copy:\n\n" + (e.message || e) + "\n\nDetails: " + path.join("build", "launch.log") + " in the ChatGPT Fastlane folder."); process.exit(1); });
  process.on("exit", (code) => { try { fs.appendFileSync(LOG, `--- exit ${code}\n`); } catch { /* ignore */ } });
} catch { /* logging is best effort */ }
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

// ---------------------------------------------------------------------------------------------
// The patch. Each gate is a regex whose literals are the stable parts of the app's source; the
// minified identifiers are wildcards with back-references. `apply` turns the match into the patched text.
// ---------------------------------------------------------------------------------------------
const ID = "[A-Za-z_$][\\w$]*";
// AppUserModelID the patched copy registers (gate G5). shortcut.ps1 writes the same id into the Start-menu entry.
const AUMID = "com.openai.codex.fastlane";
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
  {
    id: "G5 AppUserModelID: give the copy its own id so the Start-menu entry and taskbar button are its own",
    // case a.x.Prod:return"com.openai.codex"}   (main process bundle; the Store app uses its package id anyway).
    // On macOS the same function names ~/Library/Logs/<id> and the bundle id used for permission checks,
    // so it is kept equal to the copy's CFBundleIdentifier (AUMID).
    re: new RegExp("(case " + ID + "\\." + ID + "\\.Prod:return)\"com\\.openai\\.codex\"\\}", "g"),
    apply: (m) => m.replace('"com.openai.codex"', '"' + AUMID + '"'),
    optional: true, // cosmetic: if OpenAI restructures this, the build goes on without it (warning printed)
  },
];
// Verification: the patched form each gate must leave behind (and the original must be gone).
const PATCHED_FORMS = [
  /=!0\|\|[A-Za-z_$][\w$]*\?\.authMethod===`chatgpt`/,
  /if\(!1\)return null;let [A-Za-z_$][\w$]* ?= ?await/,
  /return !0\|\|[A-Za-z_$][\w$]*\?\.type===`chatgpt`/,
  /return !0\|\|[A-Za-z_$][\w$]*\.account\?\.type===`chatgpt`/,
  /Prod:return"com\.openai\.codex\.fastlane"\}/,
];
const CANDIDATE_FILES = (p) => /^webview\/assets\/.*\.js$/.test(p) || /^\.vite\/build\/.*\.js$/.test(p);

const INTEGRITY_RE = /\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/g;
const BLOCK_SIZE = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// locate the installed app
// ---------------------------------------------------------------------------------------------
// macOS: the Codex app is /Applications/ChatGPT.app with bundle id com.openai.codex (the older native
// app is "ChatGPT Classic.app", com.openai.chat, and is not touched).
const MAC_BUNDLE_ID = "com.openai.codex";
const MAC_APP_NAME = "ChatGPT Fastlane.app";

function plistGet(plist, key) {
  try { return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

function bundleIdOf(app) { return plistGet(path.join(app, "Contents", "Info.plist"), "CFBundleIdentifier"); }

function findInstalledApp() {
  if (MAC) {
    for (const p of ["/Applications/ChatGPT.app", path.join(os.homedir(), "Applications", "ChatGPT.app")]) {
      if (fs.existsSync(path.join(p, "Contents", "Resources", "app.asar")) && bundleIdOf(p) === MAC_BUNDLE_ID) return p;
    }
    throw new Error(`ChatGPT (Codex) app with bundle id ${MAC_BUNDLE_ID} not found in /Applications; pass --src <.../ChatGPT.app>`);
  }
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
  if (MAC) return plistGet(path.join(src, "Contents", "Info.plist"), "CFBundleShortVersionString") ?? "unknown";
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
  if (MAC) {
    // No Store on macOS: the app updates itself with Sparkle while it runs (the patched copy's Sparkle is off).
    const v = appVersion(findInstalledApp());
    console.log(`Installed version: ${v}. macOS has no Store update to trigger from here: ChatGPT updates itself while it runs.\n` +
      "To update now: quit the patched copy, open /Applications/ChatGPT.app, choose ChatGPT > Check for Updates..., quit it again,\n" +
      "then run launch (it builds the new version).");
    return { before: v, after: v, winget: null };
  }
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
const OUT = opt("--out", path.join(HERE, "build", VERSION, MAC ? MAC_APP_NAME : "app"));
const FULL_COPY = flag("--full-copy");
const VERIFY_ONLY = flag("--verify-only");
const IF_NEEDED = flag("--if-needed");
const LAUNCH = flag("--launch");
const STATUS = flag("--status");
const PRUNE = flag("--prune");
const SHORTCUT = flag("--shortcut");

// Start-menu entry "ChatGPT Fastlane": a shortcut to launch.cmd (minimised console while it builds or starts)
// with assets\chatgpt-fastlane.ico and the app's AppUserModelID, written by shortcut.ps1. The patched copy
// has no icon of its own (Store apps keep theirs in the package manifest), so the taskbar shows a blank
// page unless this entry is pinned there. Remove it by deleting the .lnk.
// macOS: the counterpart is a small AppleScript app ~/Applications/ChatGPT Fastlane.app (osacompile) that runs
// launch with this Node; it keeps working across versions, unlike a Dock item pointing into build/<version>/.
const SHORTCUT_NAME = "ChatGPT Fastlane";
function shortcutPath() {
  if (MAC) return path.join(os.homedir(), "Applications", SHORTCUT_NAME + ".app");
  return path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", SHORTCUT_NAME + ".lnk");
}
function installShortcut() {
  if (MAC) {
    const app = shortcutPath();
    const q = (s) => "quoted form of " + JSON.stringify(s);
    const cmd = `"cd " & ${q(HERE)} & " && " & ${q(process.execPath)} & " patch-codex-speed.mjs --full-copy --if-needed --launch --gui > /dev/null 2>&1"`;
    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(app), { recursive: true });
    // the script shows its own message boxes (--gui); a non-zero exit must not add AppleScript's error dialog
    execFileSync("osacompile", ["-o", app, "-e", `try\n do shell script ${cmd}\nend try`]);
    const plist = path.join(app, "Contents", "Info.plist");
    execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", AUMID + ".launcher", plist]);
    try { execFileSync("plutil", ["-remove", "CFBundleIconName", plist], { stdio: "ignore" }); } catch { /* not present */ } // else Assets.car's script icon wins
    fs.writeFileSync(path.join(app, "Contents", "Resources", "applet.icns"), icns());
    execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    spawnSync("touch", [app]); // let Finder and the Dock pick up the new icon
    console.log(`Wrote ${app} (runs launch with ${process.execPath}). Drag it to the Dock to keep it there.`);
    return app;
  }
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
function locateGates(fd, header, dataBase, candidate = CANDIDATE_FILES, quietOptional = false) {
  const hits = GATES.map(() => []); // per gate: [{file, index, match}]
  const texts = new Map();
  for (const [p, e] of walk(header)) {
    if (!candidate(p) || e.unpacked || e.size < 1000) continue;
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
  hits.forEach((h, i) => {
    if (h.length === 0 && GATES[i].optional) { if (!quietOptional) console.log(`  warning: ${GATES[i].id}: no match in this version; skipped (optional gate)`); return; }
    if (h.length !== 1) problems.push(`${GATES[i].id}: ${h.length} match(es)` + h.map((x) => ` [${x.file} @${x.index}]`).join(""));
  });
  if (problems.length) throw new Error("The app's code changed; gates could not be matched exactly once:\n  " + problems.join("\n  ") + "\nRe-derive the patterns for this version (see docs/notes.md section 2).");
  return { hits: hits.map((h) => h[0] ?? null), texts };
}

// Patched bytes of every bundle a gate matched in; `patched` lists what was replaced where.
function patchBundles(fd, header, dataBase, candidate, quietOptional) {
  const { hits, texts } = locateGates(fd, header, dataBase, candidate, quietOptional);
  const patchedBytes = new Map();
  const patched = [];
  for (const [file, text] of texts) {
    let t = text;
    GATES.forEach((g, i) => {
      const h = hits[i];
      if (!h || h.file !== file) return;
      const before = t.length;
      t = t.replace(h.match, () => g.apply(h.match));
      patched.push({ file, id: g.id, offset: h.index, matched: h.match.slice(0, 120), delta: t.length - before });
    });
    patchedBytes.set(file, Buffer.from(t, "utf8"));
  }
  return { patchedBytes, patched };
}

function buildPatchedAsar(srcAsar, outAsar) {
  const { fd, header, json: oldJson, dataBase } = readAsarHeader(srcAsar);
  const report = { srcAsar, outAsar, oldHeaderSha256: sha256(oldJson), patched: [] };

  const { patchedBytes, patched } = patchBundles(fd, header, dataBase);
  report.patched = patched;

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

// ---------------------------------------------------------------------------------------------
// macOS sealing. Two places hold the expected asar header hash:
//   * Info.plist ElectronAsarIntegrity["Resources/app.asar"].hash (stock Electron), and
//   * a 66-byte section __DATA_CONST,__asar_integrity in "Codex Framework" (OpenAI's runtime): the 32-char
//     sentinel below, two flag bytes, then sha256("Resources/app.asar" + "SHA256" + hash). If the plist hash
//     does not match this pin, the runtime aborts with "Failed to get integrity for validatable asar archive".
// Rewriting the framework breaks its signature, and the helpers load it under library validation, so the
// copy is re-signed ad hoc inside-out: helpers, framework, app, with the original entitlements minus the
// ones only a provisioning profile of OpenAI's team can grant (the profile is removed).
// ---------------------------------------------------------------------------------------------
const MAC_ASAR_REL = "Resources/app.asar";
const MAC_PIN_SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A", "latin1");
const MAC_FRAMEWORK = path.join("Contents", "Frameworks", "Codex Framework.framework");
const RESTRICTED_ENTITLEMENT = /^com\.apple\.(application-identifier|developer\..*)$|^keychain-access-groups$|^com\.apple\.security\.application-groups$/;

const macPin = (hash) => crypto.createHash("sha256").update(MAC_ASAR_REL + "SHA256" + hash).digest();
// the framework binary itself (Versions/<chromium version>/Codex Framework), resolved through Versions/Current
function macFrameworkBinary(app) {
  const versions = path.join(app, MAC_FRAMEWORK, "Versions");
  const current = path.join(versions, "Current", "Codex Framework");
  if (fs.existsSync(current)) return fs.realpathSync(current);
  // dry-run output: only Versions/<version>/Codex Framework, no Current symlink
  for (const v of fs.existsSync(versions) ? fs.readdirSync(versions) : []) if (fs.existsSync(path.join(versions, v, "Codex Framework"))) return path.join(versions, v, "Codex Framework");
  throw new Error("Codex Framework binary not found under " + versions);
}
function macPlistHash(app) {
  try {
    const j = execFileSync("plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(j)[MAC_ASAR_REL]?.hash ?? null;
  } catch { return null; }
}

function findPin(buf) {
  const at = buf.indexOf(MAC_PIN_SENTINEL);
  if (at < 0 || buf.indexOf(MAC_PIN_SENTINEL, at + 1) >= 0) throw new Error("expected exactly 1 __asar_integrity pin in Codex Framework, found " + (at < 0 ? 0 : "more than 1"));
  return at + MAC_PIN_SENTINEL.length + 2;
}

function macClone(src, out) {
  if (fs.existsSync(out)) removeTree(out); // our own build folder of this version; rebuilt from scratch
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // APFS clone: the 1.7 GB copy shares blocks with the installed app until a file is rewritten
  const r = spawnSync("cp", ["-Rc", src, out], { stdio: "inherit" });
  if (r.status !== 0) {
    console.log("  APFS clone not possible here; copying with ditto (~1.7 GB)...");
    if (fs.existsSync(out)) removeTree(out);
    execFileSync("ditto", [src, out]);
  }
}

function macSeal(src, out, oldHash, newHash, fullCopy) {
  const srcPlist = path.join(src, "Contents", "Info.plist");
  if (macPlistHash(src) !== oldHash) throw new Error(`Info.plist ElectronAsarIntegrity hash ${macPlistHash(src)} does not match the installed app.asar header hash ${oldHash}`);
  const fwSrc = macFrameworkBinary(src);
  const fw = path.join(out, path.relative(src, fwSrc));
  const buf = fs.readFileSync(fwSrc);
  const at = findPin(buf);
  if (!buf.subarray(at, at + 32).equals(macPin(oldHash))) throw new Error("the __asar_integrity pin in Codex Framework does not match the installed app.asar header hash");
  macPin(newHash).copy(buf, at);
  fs.mkdirSync(path.dirname(fw), { recursive: true });
  fs.rmSync(fw, { force: true }); // never write through a clone of the installed file
  fs.writeFileSync(fw, buf, { mode: 0o755 });

  const plist = path.join(out, "Contents", "Info.plist");
  if (!fullCopy) { fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.copyFileSync(srcPlist, plist); }
  const set = (...a) => execFileSync("plutil", [...a, plist]);
  set("-replace", "ElectronAsarIntegrity", "-json", JSON.stringify({ [MAC_ASAR_REL]: { algorithm: "SHA256", hash: newHash } }));
  // own identity: Dock/Finder name, bundle id (matches gate G5), updater off, own icon
  set("-replace", "CFBundleIdentifier", "-string", AUMID);
  set("-replace", "CFBundleName", "-string", SHORTCUT_NAME);
  set("-replace", "CFBundleDisplayName", "-string", SHORTCUT_NAME);
  set("-replace", "LSEnvironment.CODEX_SPARKLE_ENABLED", "-string", "false");
  set("-replace", "CFBundleIconFile", "-string", "fastlane.icns");
  try { set("-remove", "CFBundleIconName"); } catch { /* not present */ } // else the asset catalog's icon wins
  fs.writeFileSync(path.join(out, "Contents", "Resources", "fastlane.icns"), icns());
  return { plist, framework: fw, pinOffset: at, oldHash, newHash };
}

function macEntitlements(target, tmp) {
  const xml = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", target], { encoding: "utf8" }).stdout;
  if (!xml || !xml.includes("<plist")) return null;
  const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml, encoding: "utf8" }));
  for (const k of Object.keys(json)) if (RESTRICTED_ENTITLEMENT.test(k)) delete json[k];
  fs.writeFileSync(tmp, JSON.stringify(json));
  execFileSync("plutil", ["-convert", "xml1", tmp]);
  return tmp;
}

function macSign(out) {
  fs.rmSync(path.join(out, "Contents", "embedded.provisionprofile"), { force: true });
  const tmp = path.join(os.tmpdir(), `fastlane-entitlements-${process.pid}.plist`);
  const sign = (target) => {
    const ent = macEntitlements(target, tmp);
    // no hardened runtime: an ad-hoc process with library validation could not load the other ad-hoc code
    execFileSync("codesign", ["--force", "--sign", "-", ...(ent ? ["--entitlements", ent] : []), target], { stdio: ["ignore", "ignore", "pipe"] });
  };
  const versionDir = path.dirname(macFrameworkBinary(out));
  const helpers = path.join(versionDir, "Helpers");
  for (const h of fs.readdirSync(helpers).filter((n) => n.endsWith(".app"))) sign(path.join(helpers, h));
  sign(versionDir);
  sign(out);
  fs.rmSync(tmp, { force: true });
}

// .icns with the 256 px PNG from make-icon.mjs (assets/chatgpt-fastlane-256.png) as ic08 and ic13 (128@2x)
function icns() {
  const png = fs.readFileSync(path.join(HERE, "assets", "chatgpt-fastlane-256.png"));
  const entry = (type) => { const h = Buffer.alloc(8); h.write(type, 0, "latin1"); h.writeUInt32BE(8 + png.length, 4); return Buffer.concat([h, png]); };
  const body = Buffer.concat([entry("ic08"), entry("ic13")]);
  const head = Buffer.alloc(8); head.write("icns", 0, "latin1"); head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------------------------
// Live mode (what launch does on macOS; on Windows experimental, --launch --live, until tested). A patched copy
// loses OpenAI's signature (macOS: team signature; the Computer Use service and the app's own tool pipe then refuse
// it, docs/notes.md section 11). Live mode changes no file: it starts the installed app with a DevTools port on
// 127.0.0.1 (random, port 0) and a helper process that stays connected while the app runs and answers the windows'
// requests for the renderer bundles with the gate-patched bytes (Fetch domain). New windows are held at start
// (waitForDebuggerOnStart) until interception is on; windows that loaded before the helper connected are reloaded.
// G5 (main process) is not needed: the app keeps its own id. Cost: while the app runs, local processes can drive it
// through that port (web pages cannot: no allowed origins).
// Windows: the Store app is started by its AppUserModelID with arguments (IApplicationActivationManager), so it keeps
// its package identity; its profile, and so DevToolsActivePort, is redirected into the package's LocalCache.
// ---------------------------------------------------------------------------------------------
const LIVE_PID = path.join(HERE, "build", "live-helper.pid");
const LIVE_CANDIDATE = (p) => /^webview\/assets\/.*\.js$/.test(p);
const LIVE_ARGS = "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1";
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ps = (command, env = {}) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }).trim();

// Windows: package family name and the app's AppUserModelID (PackageFamilyName!AppId)
let winPkg = null;
function winPackage() {
  if (!winPkg) {
    const [pfn, id] = ps("$p = Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1; " +
      "$id = ($p | Get-AppxPackageManifest).Package.Applications.Application | Select-Object -First 1 -ExpandProperty Id; \"$($p.PackageFamilyName)|$id\"").split("|");
    if (!pfn || !id) throw new Error("could not read the OpenAI.Codex package's AppUserModelID");
    winPkg = { pfn, aumid: pfn + "!" + id };
  }
  return winPkg;
}

// Start the Store app with arguments, or, if it runs, hand it a new activation (brings it to the front). Returns the pid.
const WIN_ACTIVATE = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] class ApplicationActivationManager {}
public static class FastlaneActivate {
  public static uint Run(string id, string args) {
    uint pid; int hr = ((IApplicationActivationManager)new ApplicationActivationManager()).ActivateApplication(id, args, 0, out pid);
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    return pid;
  }
}
'@
[FastlaneActivate]::Run($env:FASTLANE_AUMID, $env:FASTLANE_ARGS)`;
function winActivate(args) { return ps(WIN_ACTIVATE, { FASTLANE_AUMID: winPackage().aumid, FASTLANE_ARGS: args }); }

function devToolsPortFiles() {
  if (MAC) return [path.join(os.homedir(), "Library", "Application Support", "Codex", "DevToolsActivePort")];
  // Windows: Chromium's user-data folder is Codex\web\Codex inside the app's profile (seen 2026-11-03, 26.1027.3384.0);
  // the Store app's profile is redirected into the package's LocalCache. The plain Codex\ paths are kept as fallbacks.
  const pkgRoaming = path.join(process.env.LOCALAPPDATA, "Packages", winPackage().pfn, "LocalCache", "Roaming");
  return [path.join(pkgRoaming, "Codex", "web", "Codex", "DevToolsActivePort"), path.join(pkgRoaming, "Codex", "DevToolsActivePort"),
    path.join(process.env.APPDATA, "Codex", "web", "Codex", "DevToolsActivePort"), path.join(process.env.APPDATA, "Codex", "DevToolsActivePort")];
}

// port from a DevToolsActivePort file written at or after `since` (ms since epoch)
function readPortFile(since = 0) {
  for (const f of devToolsPortFiles()) {
    try { if (fs.statSync(f).mtimeMs >= since - 1000) { const p = Number(fs.readFileSync(f, "utf8").split(/\r?\n/)[0]); if (p) return p; } } catch { /* not there */ }
  }
  return null;
}

function liveAsar(src) { return MAC ? path.join(src, "Contents", "Resources", "app.asar") : path.join(src, "resources", "app.asar"); }

// app://-/assets/<bundle>.js -> base64 of the patched bundle; throws if G1-G4 do not match exactly once
function livePatches(src) {
  const { fd, header, dataBase } = readAsarHeader(liveAsar(src));
  try {
    const { patchedBytes, patched } = patchBundles(fd, header, dataBase, LIVE_CANDIDATE, true);
    const byUrl = new Map();
    for (const [file, bytes] of patchedBytes) byUrl.set("app://-/" + file.replace(/^webview\//, ""), bytes.toString("base64"));
    return { byUrl, patched };
  } finally { fs.closeSync(fd); }
}

// command line of the installed app's main process (not a helper), or null
function officialCommandLine() {
  if (MAC) {
    let out = "";
    try { out = execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" }); } catch { return null; }
    return out.split("\n").find((l) => l.startsWith(path.join(SRC, "Contents", "MacOS", "ChatGPT"))) ?? null;
  }
  try {
    return ps("Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.ExecutablePath -like '*\\WindowsApps\\*' } | " +
      "Select-Object -First 1 -ExpandProperty CommandLine") || null;
  } catch { return null; }
}

// DevTools port of the running installed app, or null if it runs without one (started normally)
function liveDebugPort() {
  const m = officialCommandLine()?.match(/--remote-debugging-port=(\d+)/);
  if (!m) return null;
  return m[1] !== "0" ? Number(m[1]) : readPortFile();
}

function liveHelperPid() {
  try { const pid = Number(fs.readFileSync(LIVE_PID, "utf8")); process.kill(pid, 0); return pid; } catch { return null; }
}

function liveLaunch() {
  const running = runningChatGPT();
  const official = running.filter((p) => MAC ? p.startsWith(SRC + "/") : /\\WindowsApps\\/i.test(p));
  const other = running.filter((p) => !official.includes(p));
  if (other.length) {
    const msg = "A patched ChatGPT copy is running:\n" + other[0] + "\n\nQuit it first, then start ChatGPT Fastlane again.";
    console.log(msg); popup(msg); return 2;
  }
  let port = official.length ? liveDebugPort() : null;
  if (official.length && port == null) {
    const msg = "ChatGPT is running without Fastlane.\n\nQuit it (" + (MAC ? "ChatGPT > Quit, or Cmd-Q" : "its tray icon too") + "), then start ChatGPT Fastlane again.";
    console.log(msg); popup(msg); return 2;
  }
  const { patched } = livePatches(SRC); // fail before starting anything if the gates moved
  for (const p of patched) console.log(`  ${p.id}\n     ${p.file} @${p.offset}`);
  if (!official.length) {
    const t0 = Date.now();
    for (const f of devToolsPortFiles()) fs.rmSync(f, { force: true });
    if (MAC) execFileSync("open", ["-a", SRC, "--args", ...LIVE_ARGS.split(" ")]);
    else console.log(`Activated ${winPackage().aumid} (pid ${winActivate(LIVE_ARGS)})`);
    for (let i = 0; i < 60 && port == null; i++) { sleepMs(500); port = readPortFile(t0); }
    if (port == null) throw new Error(`ChatGPT started but opened no DevTools port within 30 s; this version may not allow it. Use ${MAC ? "--copy" : "the patched copy (launch.cmd)"}.`);
    console.log(`Started ${SRC} with its DevTools port on 127.0.0.1:${port}`);
  }
  if (liveHelperPid()) {
    if (MAC) execFileSync("open", ["-a", SRC]); else winActivate("");
    console.log("ChatGPT Fastlane is already running; brought ChatGPT to the front.");
    return 0;
  }
  fs.rmSync(LIVE_PID, { force: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--live-helper", "--port", String(port), ...(GUI ? ["--gui"] : [])],
    { detached: true, stdio: "ignore", cwd: HERE, windowsHide: true });
  child.unref();
  for (let i = 0; i < 40 && !liveHelperPid(); i++) sleepMs(500);
  if (!liveHelperPid()) throw new Error("the live helper did not come up; see " + path.join("build", "launch.log"));
  console.log(`Live helper running (pid ${liveHelperPid()}); ChatGPT is patched in memory. Helper output: ${path.join("build", "launch.log")}`);
  return 0;
}

async function liveHelper(port) {
  const { byUrl, patched } = livePatches(SRC);
  console.log(`Live helper ${process.pid}: ${patched.length} gate(s) in ${byUrl.size} bundle(s), port ${port}`);
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let next = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++next; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  let served = 0;
  const onAttached = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type === "page") {
      await send("Fetch.enable", { patterns: [{ urlPattern: "app://-/assets/*" }] }, sessionId);
      // a window that loaded before interception was on still runs the original bundle
      if (!waitingForDebugger && targetInfo.url.startsWith("app://-/")) { await send("Page.reload", {}, sessionId); console.log(`  reloaded ${targetInfo.url}`); }
    }
    if (waitingForDebugger) await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Target.attachedToTarget") onAttached(m.params).catch((e) => console.log("  attach: " + e.message));
    if (m.method === "Fetch.requestPaused") {
      const url = m.params.request.url.split(/[?#]/)[0];
      const body = byUrl.get(url);
      if (body) {
        served++;
        console.log(`  served patched ${url} (${served})`);
        send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, body,
          responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }] }, m.sessionId);
      } else send("Fetch.continueRequest", { requestId: m.params.requestId }, m.sessionId);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("cannot connect to the DevTools port")); });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  fs.writeFileSync(LIVE_PID, String(process.pid));
  console.log("Live helper ready.");
  await new Promise((resolve) => { ws.onclose = resolve; });
  console.log(`ChatGPT quit; live helper exits (served ${served} patched bundle(s)).`);
  try { if (fs.readFileSync(LIVE_PID, "utf8") === String(process.pid)) fs.rmSync(LIVE_PID); } catch { /* gone */ }
}

function copyRestOfApp(src, out) {
  const skip = new Set([path.join(src, "ChatGPT.exe").toLowerCase(), path.join(src, "resources", "app.asar").toLowerCase()]);
  fs.cpSync(src, out, { recursive: true, force: true, errorOnExist: false, filter: (s) => !skip.has(s.toLowerCase()) });
}

// macOS: the seal is the Info.plist hash plus the framework pin (instead of the hash inside ChatGPT.exe), and a
// full copy must pass `codesign --verify --deep --strict`.
function macSealCheck(outDir, headerHash) {
  const r = { plistHash: macPlistHash(outDir), pinMatches: false, bundleId: bundleIdOf(outDir) };
  try { const buf = fs.readFileSync(macFrameworkBinary(outDir)); const at = findPin(buf); r.pinMatches = buf.subarray(at, at + 32).equals(macPin(headerHash)); } catch (e) { r.pinError = e.message; }
  r.ok = r.plistHash === headerHash && r.pinMatches;
  return r;
}

function verify(outDir) {
  const asarPath = MAC ? path.join(outDir, "Contents", "Resources", "app.asar") : path.join(outDir, "resources", "app.asar");
  const exePath = MAC ? path.join(outDir, "Contents", "Info.plist") : path.join(outDir, "ChatGPT.exe");
  if (!fs.existsSync(asarPath) || !fs.existsSync(exePath)) return { ok: false, reason: "not built" };
  const { fd, header, json, dataBase } = readAsarHeader(asarPath);
  const headerHash = sha256(json);
  let result;
  if (MAC) {
    const seal = macSealCheck(outDir, headerHash);
    result = { asarPath, plistPath: exePath, headerHash, seal, exeHashMatches: seal.ok, gates: [], sampleIntegrityOk: 0, sampleIntegrityBad: [] };
  } else {
    const exeText = fs.readFileSync(exePath).toString("latin1");
    const hits = [...exeText.matchAll(INTEGRITY_RE)];
    result = { asarPath, exePath, headerHash, exeHash: hits[0]?.[1] ?? null, exeHashMatches: hits.length === 1 && hits[0][1] === headerHash, gates: [], sampleIntegrityOk: 0, sampleIntegrityBad: [] };
  }
  // every gate must now be absent in its original form and present in patched form, across the candidate files
  const patchedForms = PATCHED_FORMS;
  const found = GATES.map(() => ({ original: 0, patched: 0, integrityOk: true }));
  for (const [p, e] of walk(header)) {
    if (!CANDIDATE_FILES(p) || e.unpacked || e.size < 1000) continue;
    const buf = readEntry(fd, dataBase, e);
    const text = buf.toString("utf8");
    let touched = false;
    GATES.forEach((g, i) => { g.re.lastIndex = 0; if (g.re.test(text)) found[i].original++; if (patchedForms[i].test(text)) { found[i].patched++; touched = true; } });
    if (touched) { const integ = integrityOf(buf); const ok = integ.hash === e.integrity.hash && JSON.stringify(integ.blocks) === JSON.stringify(e.integrity.blocks); if (!ok) found.forEach((f) => (f.integrityOk = false)); }
  }
  // an optional gate that matched nowhere (neither form) is reported as skipped and does not fail verification
  result.gates = GATES.map((g, i) => ({ id: g.id, originalAbsent: found[i].original === 0, patchedPresent: found[i].patched === 1 || (g.optional && found[i].patched === 0 && found[i].original === 0), skipped: !!g.optional && found[i].patched === 0 && found[i].original === 0, integrityOk: found[i].integrityOk }));
  const all = [...walk(header)].filter(([, e]) => !e.unpacked);
  const sample = new Set([0, all.length - 1, all.reduce((m, [, e], i) => (e.size > all[m][1].size ? i : m), 0)]);
  for (let i = 0; i < all.length; i += 500) sample.add(i);
  for (const i of sample) {
    const [p, e] = all[i];
    const ok = sha256(readEntry(fd, dataBase, e)) === e.integrity.hash;
    if (ok) result.sampleIntegrityOk++; else result.sampleIntegrityBad.push(p);
  }
  fs.closeSync(fd);
  if (MAC) {
    result.fullCopyPresent = fs.existsSync(path.join(outDir, "Contents", "MacOS", "ChatGPT")) && fs.existsSync(path.join(outDir, MAC_FRAMEWORK, "Versions", "Current", "Helpers"));
    if (result.fullCopyPresent) {
      const r = spawnSync("codesign", ["--verify", "--deep", "--strict", outDir], { encoding: "utf8" });
      result.codesignOk = r.status === 0;
      if (!result.codesignOk) result.codesignError = (r.stderr || "").trim().split("\n").slice(-3).join(" | ");
    }
  } else {
    result.fullCopyPresent = fs.existsSync(path.join(outDir, "chrome.dll")) && fs.existsSync(path.join(outDir, "resources", "codex.exe"));
  }
  result.ok = result.exeHashMatches && result.gates.every((g) => g.originalAbsent && g.patchedPresent && g.integrityOk) && result.sampleIntegrityBad.length === 0 && result.codesignOk !== false;
  return result;
}

// ---------------------------------------------------------------------------------------------
// launching
// ---------------------------------------------------------------------------------------------
// Paths of running ChatGPT main executables. macOS: <bundle>.app/Contents/MacOS/ChatGPT from `ps`, minus
// ChatGPT Classic (com.openai.chat), which shares the executable name but is a different app.
function runningChatGPT() {
  if (MAC) {
    let out = "";
    try { out = execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" }); } catch { return []; }
    const exes = new Set();
    for (const line of out.split("\n")) {
      const m = line.match(/^(\/.*?\.app\/Contents\/MacOS\/ChatGPT)(?:\s|$)/);
      if (m && bundleIdOf(m[1].replace(/\/Contents\/MacOS\/ChatGPT$/, "")) !== "com.openai.chat") exes.add(m[1]);
    }
    return [...exes];
  }
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"], { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// With --gui (launch.cmd passes it), refusals and errors are also shown in a message box, because the
// launcher's console runs minimised from the Start-menu entry and closes by itself.
const GUI = flag("--gui");
function popup(text, title = "ChatGPT Fastlane") {
  if (!GUI) return;
  if (MAC) {
    try {
      execFileSync("osascript", ["-e", "on run argv", "-e", "display alert (item 1 of argv) message (item 2 of argv) as warning giving up after 120", "-e", "end run", title, text], { stdio: "ignore" });
    } catch { /* console text is still there */ }
    return;
  }
  // text and title go in through the environment: PowerShell strings do not understand JSON escapes like \n
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(New-Object -ComObject WScript.Shell).Popup($env:FASTLANE_POPUP_TEXT, 120, $env:FASTLANE_POPUP_TITLE, 48) | Out-Null"],
      { windowsHide: true, env: { ...process.env, FASTLANE_POPUP_TEXT: text, FASTLANE_POPUP_TITLE: title } });
  } catch { /* console text is still there */ }
}

function startExe(outDir) {
  if (MAC) {
    // through LaunchServices, so LSEnvironment (updater off) applies; a running copy is brought to the front
    execFileSync("open", [outDir]);
    return { exe: outDir, pid: "via open" };
  }
  const exe = path.join(outDir, "ChatGPT.exe");
  const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: outDir, windowsHide: false });
  child.unref();
  return { exe, pid: child.pid };
}

function launch(outDir) {
  const running = runningChatGPT();
  const store = running.filter((p) => MAC ? p.startsWith(SRC + "/") : /\\WindowsApps\\/i.test(p));
  const mine = running.filter((p) => p.toLowerCase().startsWith(path.resolve(outDir).toLowerCase()));
  const other = running.filter((p) => !store.includes(p) && !mine.includes(p));
  if (store.length) {
    const msg = MAC
      ? "The ChatGPT app is running:\n" + store[0] + "\n\nQuit it first (ChatGPT > Quit, or Cmd-Q), then start ChatGPT Fastlane again."
      : "The ChatGPT Store app is running:\n" + store[0] + "\n\nQuit it first (its tray icon too), then start ChatGPT Fastlane again.";
    console.log(msg); popup(msg); return 2;
  }
  if (other.length) {
    const msg = "Another ChatGPT copy is running:\n" + other[0] + "\n\nQuit it first, then start ChatGPT Fastlane again.";
    console.log(msg); popup(msg); return 2;
  }
  if (mine.length) {
    // Electron single-instance: a second start hands over to the running instance, which brings its window up.
    startExe(outDir);
    console.log("The patched copy is already running; brought its window to the front.");
    return 0;
  }
  const { exe, pid } = startExe(outDir);
  console.log(`Launched ${exe} (pid ${pid})`);
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
    const legacy = !MAC && d.name === "app";
    const app = legacy ? dir : path.join(dir, MAC ? MAC_APP_NAME : "app");
    if (!fs.existsSync(MAC ? path.join(app, "Contents", "Info.plist") : path.join(app, "ChatGPT.exe"))) continue;
    let report = null;
    try { report = JSON.parse(fs.readFileSync(legacy ? path.join(buildRoot, "report.json") : path.join(dir, "report.json"), "utf8")); } catch { /* none */ }
    const version = legacy ? (report?.version ?? appVersion(report?.src ?? "")) : d.name;
    const isRunning = running.some((p) => p.startsWith(app.toLowerCase() + path.sep.toLowerCase()) || p.startsWith(app.toLowerCase() + "\\"));
    builds.push({ name: d.name, dir, app, version, legacy, report, running: isRunning });
  }
  return builds;
}

function status() {
  console.log(`Installed ${MAC ? "" : "Store "}app: ${SRC}\n  version ${VERSION}`);
  const running = runningChatGPT();
  console.log(running.length ? `Running: ${running.join(", ")}` : "Running: nothing");
  if (MAC || liveHelperPid()) {
    const official = running.some((p) => MAC ? p.startsWith(SRC + "/") : /\\WindowsApps\\/i.test(p));
    const port = official ? liveDebugPort() : null;
    const helper = liveHelperPid();
    console.log(`Live mode (${MAC ? "launch" : "--live"}): ${!official ? "ChatGPT not running" : port == null ? "ChatGPT runs without Fastlane (normal start)" : helper ? `ChatGPT patched in memory (DevTools port ${port}, helper pid ${helper})` : `ChatGPT has DevTools port ${port} but no helper: run launch again`}`);
    if (MAC) console.log("Patched copies (--copy, fallback):");
  }
  const builds = listBuilds();
  const buildDir = "build" + path.sep;
  console.log(builds.length ? `Builds in ${buildDir}:` : `Builds in ${buildDir}: none`);
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
  if (MAC) { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); return; }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
    console.log(`  Node could not delete it (${e.code}); using rmdir /s /q instead.`);
    const r = spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", dir], { stdio: "inherit", windowsHide: true });
    if (fs.existsSync(dir)) throw new Error(`could not delete ${dir} (rmdir exit ${r.status}); check for open files and delete it by hand`);
  }
}

// Uninstall the patched copy: stop it if running, remove the Start-menu entry, delete build\ entirely.
// The Store package, ~\.codex and this folder are not touched (uninstall.cmd explains what is kept).
function uninstall() {
  const mine = runningChatGPT().filter((p) => p.toLowerCase().startsWith(path.join(HERE, "build").toLowerCase()));
  if (mine.length && MAC) {
    console.log("Quitting the running patched copy...");
    try { execFileSync("osascript", ["-e", `tell application id "${AUMID}" to quit`], { stdio: "ignore", timeout: 30000 }); } catch { /* fall through */ }
    for (let i = 0; i < 20 && runningChatGPT().some((p) => mine.includes(p)); i++) spawnSync("sleep", ["1"]);
    if (runningChatGPT().some((p) => mine.includes(p))) spawnSync("pkill", ["-f", path.join(HERE, "build") + "/"]);
  } else if (mine.length) {
    console.log("Stopping the running patched copy...");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '" + path.join(HERE, "build").replace(/'/g, "''") + "\\*' } | Stop-Process -Force"], { windowsHide: true });
  }
  if (liveHelperPid()) { process.kill(liveHelperPid()); console.log("Stopped the live helper (ChatGPT keeps running; it is unpatched after its next start)."); }
  const lnk = shortcutPath();
  if (fs.existsSync(lnk)) { fs.rmSync(lnk, { force: true, recursive: true }); console.log(`Removed ${lnk}`); }
  const buildRoot = path.join(HERE, "build");
  if (fs.existsSync(buildRoot)) { console.log(`Deleting ${buildRoot}...`); removeTree(buildRoot); }
  if (MAC) console.log(`Done. /Applications/ChatGPT.app is untouched. Kept: ~/.codex (config, sessions), ~/Library/Application Support/Codex (profile shared with ChatGPT), ~/Library/Logs/${AUMID}, and this folder.`);
  else console.log("Done. The Store app is untouched. Kept: ~\\.codex (config, sessions), %APPDATA%\\Codex (the copy's own profile, delete it by hand if unwanted), and this folder.");
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
  if (flag("--live-helper")) { liveHelper(Number(opt("--port"))).catch((e) => { console.error("ERROR live helper: " + (e.stack || e)); popup("ChatGPT Fastlane could not patch ChatGPT in memory:\n\n" + e.message); process.exit(1); }); return; }
  // live mode: the default launch on macOS; on Windows opt-in (--live) until it is tested there
  if (LAUNCH && (MAC ? !flag("--copy") : flag("--live"))) { process.exit(liveLaunch()); }
  if (STATUS) { status(); return; }
  if (PRUNE) { prune(); return; }
  if (flag("--uninstall")) { uninstall(); return; }
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
  if (needBuild && MAC) {
    if (path.resolve(OUT).toLowerCase().startsWith(path.resolve(SRC).toLowerCase())) throw new Error("refusing to write inside the installed app folder");
    if (!OUT.endsWith(".app")) throw new Error("--out must name a .app bundle on macOS");
    if (runningChatGPT().some((p) => p.startsWith(path.resolve(OUT) + "/"))) throw new Error(`the copy in ${OUT} is running; quit it before rebuilding`);
    if (FULL_COPY) { console.log("Cloning the installed app (APFS clone, ~1.7 GB without using that much disk)..."); macClone(SRC, OUT); }
    else if (fs.existsSync(OUT)) removeTree(OUT);
    report.asar = buildPatchedAsar(path.join(SRC, "Contents", "Resources", "app.asar"), path.join(OUT, "Contents", "Resources", "app.asar"));
    for (const p of report.asar.patched) console.log(`  ${p.id}\n     ${p.file} @${p.offset}: ${p.matched}${p.matched.length >= 120 ? "…" : ""}`);
    console.log(`Wrote patched app.asar (${report.asar.outSize} bytes); header hash ${report.asar.oldHeaderSha256.slice(0, 12)}… -> ${report.asar.newHeaderSha256.slice(0, 12)}…`);
    report.seal = macSeal(SRC, OUT, report.asar.oldHeaderSha256, report.asar.newHeaderSha256, FULL_COPY);
    console.log(`Updated Info.plist (integrity hash, bundle id ${AUMID}, updater off, icon) and the framework's integrity pin`);
    if (FULL_COPY) { console.log("Signing the copy ad hoc (helpers, framework, app)..."); macSign(OUT); }
  } else if (needBuild) {
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
  if (!report.verify.ok) { popup("The patched copy failed verification; it was not started.\n\nDetails: " + path.join("build", "launch.log") + " and " + path.join("build", VERSION, "report.json") + " in the ChatGPT Fastlane folder."); process.exit(1); }
  if (!report.verify.fullCopyPresent) console.log(`Note: only ${MAC ? "app.asar, Info.plist and the framework binary" : "app.asar and ChatGPT.exe"} are in the build folder (dry run). Run with --full-copy to make it launchable.`);
  if (LAUNCH) {
    if (!report.verify.fullCopyPresent) { console.log("Cannot launch: not a full copy."); popup(`Cannot start: the build folder is a dry run (no full copy). Run ${MAC ? "patch.command" : "patch.cmd"} first.`); process.exit(1); }
    const rc = launch(OUT);
    if (SHORTCUT && rc === 0) { try { installShortcut(); } catch (e) { console.log("Could not write the Start-menu entry: " + e.message); } }
    process.exit(rc);
  }
})();
