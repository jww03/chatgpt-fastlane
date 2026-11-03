#!/usr/bin/env node
// patch-codex-speed.mjs — ChatGPT Fastlane V1: start the installed ChatGPT desktop app (OpenAI's Codex app,
// Electron/"owl" runtime; Windows Store package OpenAI.Codex, macOS /Applications/ChatGPT.app) with the Speed
// (Fast / Ultrafast) controls shown and honoured for a custom model provider.
//
// Live mode, the only method since V1 (2026-11-03): no file is written anywhere in the app. The installed,
// OpenAI-signed app is started with a DevTools port on 127.0.0.1 (random port) and a helper process stays connected
// while it runs. The helper answers the windows' requests for the renderer bundle with the gate-patched bytes
// (DevTools Fetch domain); new windows are held at start until interception is on, windows that loaded earlier are
// reloaded once. The app keeps its signature and package identity, updates itself as usual, and the next launch
// patches whatever version is installed. (V0 built a patched copy of the whole app; docs/notes.md sections 1-11.)
//
// Re-applyable across app updates: the four gates are matched by their stable string literals (`chatgpt`,
// `personalAccessToken`, `amazonBedrock`, `.serviceTier`) with the minified identifiers as wildcards, in every
// renderer bundle, and each must match exactly once, or launch stops before starting anything and names the gate.
//
// Usage (launch.cmd / launch.command and the other wrappers next to this script):
//   node patch-codex-speed.mjs --launch [--gui]   # start ChatGPT patched in memory, or bring it to the front
//   node patch-codex-speed.mjs --store-update --launch
//                                                 # Windows: ask the Microsoft Store for an update first (winget);
//                                                 # macOS: explains that ChatGPT updates itself
//   node patch-codex-speed.mjs --status           # installed version, what runs, whether it is patched
//   node patch-codex-speed.mjs --check            # match the gates against the installed version, start nothing
//   node patch-codex-speed.mjs --shortcut         # Start-menu entry / ~/Applications app "ChatGPT Fastlane" -> launch
//   node patch-codex-speed.mjs --cleanup          # delete V0 patched copies left in build\ (never a running one)
//   node patch-codex-speed.mjs --uninstall        # stop the helper, remove the shortcut, delete build\
//   options: --src <installed app folder>  (Windows: ...\app with ChatGPT.exe; macOS: the .app)
//   --gui: refusals and errors also in a message box (the launchers' consoles close by themselves).
//   --live-helper --port <n> is internal (the helper process).
//
// Requirements: Node 22+ (global WebSocket; tested with Node 24). No npm packages; the asar reader is inline.
// Windows uses PowerShell; macOS uses the system's plutil, ps, open, osacompile, codesign and osascript.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const MAC = process.platform === "darwin";
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);
const GUI = flag("--gui");
const BUILD = path.join(HERE, "build");

// Everything printed also goes to build/launch.log, so a run started from a shortcut (whose console closes by
// itself) and the helper (which has no console) can be read afterwards.
const LOG = path.join(BUILD, "launch.log");
try {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.appendFileSync(LOG, `\n=== ${new Date().toISOString()} ${args.join(" ")}\n`);
  for (const k of ["log", "error", "warn"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { orig(...a); try { fs.appendFileSync(LOG, a.map(String).join(" ") + "\n"); } catch { /* ignore */ } };
  }
  process.on("uncaughtException", (e) => { console.error("ERROR " + (e.stack || e)); popup("ChatGPT Fastlane could not start ChatGPT patched:\n\n" + (e.message || e) + "\n\nDetails: " + path.join("build", "launch.log") + " in the ChatGPT Fastlane folder."); process.exit(1); });
  process.on("exit", (code) => { try { fs.appendFileSync(LOG, `--- exit ${code}\n`); } catch { /* ignore */ } });
} catch { /* logging is best effort */ }

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
// the renderer bundles, served to the windows as app://-/assets/<name>.js
const RENDERER_BUNDLE = (p) => /^webview\/assets\/.*\.js$/.test(p);

// ---------------------------------------------------------------------------------------------
// locate the installed app
// ---------------------------------------------------------------------------------------------
// macOS: the Codex app is /Applications/ChatGPT.app with bundle id com.openai.codex ("ChatGPT Classic.app",
// com.openai.chat, is a different, older app).
const MAC_BUNDLE_ID = "com.openai.codex";
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ps = (command, env = {}) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }).trim();

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
    const out = ps("(Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1).InstallLocation");
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

const appAsar = (src) => MAC ? path.join(src, "Contents", "Resources", "app.asar") : path.join(src, "resources", "app.asar");

// Microsoft Store product id of the Codex package (family OpenAI.Codex_2p2nqsd0c76g0), from
// `winget search OpenAI --source msstore`. The Store lists it under the name "ChatGPT".
const STORE_ID = "9PLM9XGG6VKS";

// Windows: ask the Microsoft Store (winget's msstore source) to install the current version of the package,
// exactly as a normal Store update would. macOS has no Store: ChatGPT updates itself with Sparkle.
function storeUpdate() {
  if (MAC) {
    console.log("macOS: ChatGPT updates itself (ChatGPT > Check for Updates...). Nothing to rebuild: the next launch patches\n" +
      "whatever version is installed. An update restarts ChatGPT unpatched; quit it and start it through launch again.");
    return;
  }
  const version = () => { try { return ps("(Get-AppxPackage -Name OpenAI.Codex | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1).Version"); } catch { return ""; } };
  const before = version();
  console.log(`Installed Store version: ${before || "(none)"}. Asking the Microsoft Store for an update (winget, product ${STORE_ID})...`);
  const r = spawnSync("winget", ["upgrade", "--id", STORE_ID, "--source", "msstore",
    "--accept-source-agreements", "--accept-package-agreements"], { stdio: "inherit", windowsHide: true });
  const after = version();
  if (r.error) console.log(`winget could not run (${r.error.message}); open the Microsoft Store > Library > Get updates instead.`);
  if (after && before && after !== before) console.log(`Store app updated: ${before} -> ${after}`);
  else if (r.status === 0x8A15002B || r.status === -1978335189) console.log(`Store app unchanged (${after || before}): the Store has no newer version.`);
  else console.log(`Store app unchanged (${after || before || "not installed"}).${r.status ? " winget exit code " + r.status + "; see its output above." : ""}`);
}

if (flag("--store-update")) storeUpdate();

const SRC = opt("--src", null) ?? findInstalledApp();
const VERSION = appVersion(SRC);

// ---------------------------------------------------------------------------------------------
// asar reader (format: [u32 4][u32 headerPickleLen][u32 4+paddedJson][u32 jsonLen][json padded to 4][data...])
// ---------------------------------------------------------------------------------------------
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const h = Buffer.alloc(16);
  fs.readSync(fd, h, 0, 16, 0);
  if (h.readUInt32LE(0) !== 4) throw new Error("not an asar: " + asarPath);
  const json = Buffer.alloc(h.readUInt32LE(12));
  fs.readSync(fd, json, 0, json.length, 16);
  return { fd, header: JSON.parse(json.toString("utf8")), dataBase: 8 + h.readUInt32LE(4) };
}

function* walk(node, prefix = "") {
  for (const [name, entry] of Object.entries(node.files)) {
    if (entry.files) yield* walk(entry, prefix + name + "/");
    else yield [prefix + name, entry];
  }
}

function readEntry(fd, dataBase, entry) {
  const buf = Buffer.alloc(entry.size);
  if (entry.size > 0) fs.readSync(fd, buf, 0, entry.size, dataBase + Number(entry.offset));
  return buf;
}

// ---------------------------------------------------------------------------------------------
// find and apply the gates in the renderer bundles of the installed app (in memory)
// ---------------------------------------------------------------------------------------------
function locateGates(fd, header, dataBase) {
  const hits = GATES.map(() => []); // per gate: [{file, index, match}]
  const texts = new Map();
  for (const [p, e] of walk(header)) {
    if (!RENDERER_BUNDLE(p) || e.unpacked || e.size < 1000) continue;
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
  if (problems.length) throw new Error("The app's code changed; gates could not be matched exactly once:\n  " + problems.join("\n  ") + "\nRe-derive the patterns for this version (see docs/notes.md section 2).");
  return { hits: hits.map((h) => h[0]), texts };
}

// app://-/assets/<bundle>.js -> base64 of the patched bundle, plus what was replaced where
function livePatches(src) {
  const { fd, header, dataBase } = readAsarHeader(appAsar(src));
  try {
    const { hits, texts } = locateGates(fd, header, dataBase);
    const byUrl = new Map();
    const patched = [];
    for (const [file, text] of texts) {
      let t = text;
      GATES.forEach((g, i) => {
        if (hits[i].file !== file) return;
        t = t.replace(hits[i].match, () => g.apply(hits[i].match));
        patched.push({ file, id: g.id, offset: hits[i].index, matched: hits[i].match.slice(0, 120) });
      });
      byUrl.set("app://-/" + file.replace(/^webview\//, ""), Buffer.from(t, "utf8").toString("base64"));
    }
    return { byUrl, patched };
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------------------------
// processes, message boxes
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
    return ps("Get-Process ChatGPT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
const isInstalledApp = (exe) => MAC ? exe.startsWith(SRC + "/") : /\\WindowsApps\\/i.test(exe);

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

// ---------------------------------------------------------------------------------------------
// live mode
// Windows: the Store app is started by its AppUserModelID with arguments (IApplicationActivationManager), so it keeps
// its package identity; its profile, and so DevToolsActivePort, is redirected into the package's LocalCache.
// Cost: while the app runs, local processes can drive it through the DevTools port (web pages cannot: no allowed
// origins). The port is random and bound to 127.0.0.1 only.
// ---------------------------------------------------------------------------------------------
const LIVE_PID = path.join(BUILD, "live-helper.pid");
const LIVE_ARGS = "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1";

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

function launch() {
  const running = runningChatGPT();
  const official = running.filter(isInstalledApp);
  const other = running.filter((p) => !official.includes(p));
  if (other.length) {
    const msg = "A patched ChatGPT copy from Fastlane V0 is running:\n" + other[0] + "\n\nQuit it first, then start ChatGPT Fastlane again (cleanup deletes those copies).";
    console.log(msg); popup(msg); return 2;
  }
  let port = official.length ? liveDebugPort() : null;
  if (official.length && port == null) {
    const msg = "ChatGPT is running without Fastlane.\n\nQuit it (" + (MAC ? "ChatGPT > Quit, or Cmd-Q" : "its tray icon too") + "), then start ChatGPT Fastlane again.";
    console.log(msg); popup(msg); return 2;
  }
  const { patched } = livePatches(SRC); // fail before starting anything if the gates moved
  console.log(`Installed app: ${SRC} (version ${VERSION})`);
  for (const p of patched) console.log(`  ${p.id}\n     ${p.file} @${p.offset}`);
  if (!official.length) {
    const t0 = Date.now();
    for (const f of devToolsPortFiles()) fs.rmSync(f, { force: true });
    if (MAC) execFileSync("open", ["-a", SRC, "--args", ...LIVE_ARGS.split(" ")]);
    else console.log(`Activated ${winPackage().aumid} (pid ${winActivate(LIVE_ARGS)})`);
    for (let i = 0; i < 60 && port == null; i++) { sleepMs(500); port = readPortFile(t0); }
    if (port == null) throw new Error("ChatGPT started but opened no DevTools port within 30 s; this version may not allow it any more (see AGENTS.md, \"When something fails\").");
    console.log(`Started ChatGPT with its DevTools port on 127.0.0.1:${port}`);
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

// ---------------------------------------------------------------------------------------------
// shortcut: Windows Start-menu entry "ChatGPT Fastlane" -> launch.cmd (shortcut.ps1, icon assets\chatgpt-fastlane.ico);
// macOS ~/Applications/ChatGPT Fastlane.app, a small AppleScript app (osacompile) that runs launch with this Node.
// ---------------------------------------------------------------------------------------------
const SHORTCUT_NAME = "ChatGPT Fastlane";
function shortcutPath() {
  if (MAC) return path.join(os.homedir(), "Applications", SHORTCUT_NAME + ".app");
  return path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", SHORTCUT_NAME + ".lnk");
}

// .icns with the 256 px PNG from make-icon.mjs (assets/chatgpt-fastlane-256.png) as ic08 and ic13 (128@2x)
function icns() {
  const png = fs.readFileSync(path.join(HERE, "assets", "chatgpt-fastlane-256.png"));
  const entry = (type) => { const h = Buffer.alloc(8); h.write(type, 0, "latin1"); h.writeUInt32BE(8 + png.length, 4); return Buffer.concat([h, png]); };
  const body = Buffer.concat([entry("ic08"), entry("ic13")]);
  const head = Buffer.alloc(8); head.write("icns", 0, "latin1"); head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function installShortcut() {
  if (MAC) {
    const app = shortcutPath();
    const q = (s) => "quoted form of " + JSON.stringify(s);
    const cmd = `"cd " & ${q(HERE)} & " && " & ${q(process.execPath)} & " patch-codex-speed.mjs --launch --gui > /dev/null 2>&1"`;
    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(app), { recursive: true });
    // the script shows its own message boxes (--gui); a non-zero exit must not add AppleScript's error dialog
    execFileSync("osacompile", ["-o", app, "-e", `try\n do shell script ${cmd}\nend try`]);
    const plist = path.join(app, "Contents", "Info.plist");
    execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", "com.openai.codex.fastlane.launcher", plist]);
    try { execFileSync("plutil", ["-remove", "CFBundleIconName", plist], { stdio: "ignore" }); } catch { /* not present */ } // else Assets.car's script icon wins
    fs.writeFileSync(path.join(app, "Contents", "Resources", "applet.icns"), icns());
    execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    spawnSync("touch", [app]); // let Finder and the Dock pick up the new icon
    console.log(`Wrote ${app} (runs launch with ${process.execPath}). Drag it to the Dock to keep it there.`);
    return;
  }
  console.log(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(HERE, "shortcut.ps1"), "-Lnk", shortcutPath()], { encoding: "utf8", windowsHide: true }).trim());
}

// ---------------------------------------------------------------------------------------------
// status, check, cleanup, uninstall
// ---------------------------------------------------------------------------------------------
// V0 left one patched copy of the whole app per version in build\<version>\ (Windows ~2 GB each)
function leftoverCopies() {
  if (!fs.existsSync(BUILD)) return [];
  return fs.readdirSync(BUILD, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(BUILD, d.name));
}

function status() {
  console.log(`Installed app: ${SRC}\n  version ${VERSION}`);
  const running = runningChatGPT();
  console.log(running.length ? `Running: ${running.join(", ")}` : "Running: nothing");
  const official = running.some(isInstalledApp);
  const port = official ? liveDebugPort() : null;
  const helper = liveHelperPid();
  console.log(`ChatGPT Fastlane: ${!official ? "ChatGPT not running" : port == null ? "ChatGPT runs without Fastlane (started normally): quit it and use launch" : helper ? `ChatGPT patched in memory (DevTools port ${port}, helper pid ${helper})` : `ChatGPT has DevTools port ${port} but no helper: run launch again`}`);
  try { console.log(`Gates on the installed version: ${livePatches(SRC).patched.length} of ${GATES.length} found exactly once`); } catch (e) { console.log("Gates on the installed version: " + e.message); }
  const left = leftoverCopies();
  if (left.length) console.log(`Patched copies left over from V0 (cleanup deletes them): ${left.map((d) => path.basename(d)).join(", ")}`);
}

function check() {
  const { patched } = livePatches(SRC);
  console.log(`Installed app: ${SRC} (version ${VERSION})`);
  for (const p of patched) console.log(`  ${p.id}\n     ${p.file} @${p.offset}: ${p.matched}${p.matched.length >= 120 ? "…" : ""}`);
  console.log(`OK: all ${GATES.length} gates match exactly once; launch can patch this version.`);
}

// fs.rmSync failed with EPERM on a copied app folder (2026-11-03: no read-only files, nothing running,
// 3841 items; `rm -rf` and `rmdir /s /q` delete it fine). So: try Node, then fall back to cmd's rmdir.
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
    if (MAC) throw e;
    console.log(`  Node could not delete it (${e.code}); using rmdir /s /q instead.`);
    const r = spawnSync("cmd.exe", ["/d", "/c", "rmdir", "/s", "/q", dir], { stdio: "inherit", windowsHide: true });
    if (fs.existsSync(dir)) throw new Error(`could not delete ${dir} (rmdir exit ${r.status}); check for open files and delete it by hand`);
  }
}

// Delete the V0 copies in build\ (launch.log and the helper's pid file stay). A copy that is running is kept.
function cleanup() {
  const running = runningChatGPT().map((p) => p.toLowerCase());
  let removed = 0;
  for (const dir of leftoverCopies()) {
    if (running.some((p) => p.startsWith(dir.toLowerCase() + path.sep))) { console.log(`Keeping ${dir}: a ChatGPT copy is running from it. Quit it and run cleanup again.`); continue; }
    console.log(`Deleting ${dir}...`);
    removeTree(dir);
    removed++;
  }
  console.log(removed ? `Deleted ${removed} leftover V0 cop${removed === 1 ? "y" : "ies"}.` : "Nothing to delete.");
}

// Stop the helper, remove the shortcut, delete build\. ChatGPT itself, ~/.codex and this folder are not touched.
function uninstall() {
  const helper = liveHelperPid();
  if (helper) { process.kill(helper); console.log("Stopped the live helper (ChatGPT keeps running; it is unpatched from its next start)."); }
  const lnk = shortcutPath();
  if (fs.existsSync(lnk)) { fs.rmSync(lnk, { force: true, recursive: true }); console.log(`Removed ${lnk}`); }
  if (leftoverCopies().length) cleanup();
  if (fs.existsSync(BUILD)) { console.log(`Deleting ${BUILD}...`); removeTree(BUILD); }
  console.log("Done. The installed ChatGPT app was never changed. Kept: ~/.codex (config, sessions) and this folder.");
}

// ---------------------------------------------------------------------------------------------
(function main() {
  if (flag("--live-helper")) { liveHelper(Number(opt("--port"))).catch((e) => { console.error("ERROR live helper: " + (e.stack || e)); popup("ChatGPT Fastlane could not patch ChatGPT in memory:\n\n" + e.message); process.exit(1); }); return; }
  if (flag("--status")) { status(); return; }
  if (flag("--check")) { check(); return; }
  if (flag("--cleanup") || flag("--prune")) { cleanup(); return; }
  if (flag("--uninstall")) { uninstall(); return; }
  if (flag("--shortcut")) installShortcut();
  if (flag("--launch")) process.exit(launch());
  if (!flag("--shortcut") && !flag("--store-update")) check(); // no action given: show whether this version can be patched
})();
