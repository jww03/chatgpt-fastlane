# Rules for agents working in this folder (Codex, Claude Code, others)

This folder builds a **patched copy of the ChatGPT desktop app for Windows and macOS** (OpenAI's Codex app, renamed ChatGPT in the Store; the package is still `OpenAI.Codex`; on macOS `/Applications/ChatGPT.app`, bundle id `com.openai.codex`) in which the Speed controls
(Standard / Fast / Ultrafast) are shown and the chosen `service_tier` is sent for a custom model provider.
The installed app is never modified; the copy lives under `build\<version>\app\`. On macOS `launch` uses **live mode**
instead (the official app, patched in memory through a DevTools port); the copy `build/<version>/ChatGPT Fastlane.app`
is the fallback (`--copy`).
Read [README.md](README.md) for the overview and [docs/notes.md](docs/notes.md) for the full analysis; this file is the operating manual.

## What you may and may not do

- **Never write into** `C:\Program Files\WindowsApps\…` (the Store package) or `/Applications/ChatGPT.app` (macOS). The script
  refuses it; do not work around that. On macOS never `codesign`, `plutil` or `xattr` the original either
- **Never start, quit or kill the app without the user's OK in the conversation.** Launching is `launch.cmd`/`launch.command` or
  `--launch`; both refuse while the Store app (macOS: `/Applications/ChatGPT.app`) or another copy runs. Say what is running
  and let the user quit it
- **Never delete `build\` folders by hand.** Use `cleanup.cmd` / `--prune`: it keeps the installed version's build and
  anything running. Ask before running it
- **No secrets anywhere in this folder.** `~/.codex/config.toml` holds a bearer token; quote it only with the value redacted.
  Never print or log API keys, tokens or the gateway key
- **Do not change the gateway or any server** from here. Tier behaviour on the gateway side (forced tiers per group) is
  documented in the fysics-infra repo (`docs/guests/bu01/ct121-sub2api.md`); changing it is a separate, approved task
- No Python on the Windows PC (the Mac has it, but keep the tooling Node-only). Use Node (18+, tested with 24). No npm
  packages are needed; do not add any. On macOS the script also calls the system's `plutil`, `codesign`, `cp`, `ps`,
  `open`, `osacompile`, `osascript`

## Entry points (double-click, or run the script directly)

Every `.cmd` below has a macOS twin `<name>.command` (zsh, double-click in Finder) with the same flags; on macOS the
shortcut is `~/Applications/ChatGPT Fastlane.app` (an `osacompile` applet running launch with the Node that created it)
and `update` cannot trigger an update (no Store; ChatGPT updates itself with Sparkle), it only explains and then launches.

| File | Does | Script call |
|---|---|---|
| `launch.cmd` | Build the installed version if not built yet, then start the copy | `node patch-codex-speed.mjs --full-copy --if-needed --launch` |
| `update.cmd` | Ask the Microsoft Store for an update (winget, product `9PLM9XGG6VKS`), build the new version if needed, start it, print status | `--store-update --full-copy --if-needed --launch` |
| `patch.cmd` | Build only (about 2 GB, a few minutes), start nothing | `--full-copy --if-needed` |
| `status.cmd` | Installed version, builds + verification state, what is running, stale builds | `--status` |
| `cleanup.cmd` | Show status, ask, delete builds of other versions | `--prune` |
| `check-tier.cmd` | Tier of each turn in the last 3 hours from the engine's log database | `node check-tier.mjs 3` |
| `shortcut.cmd` | Create/refresh the Start-menu entry "ChatGPT Fastlane" → `launch.cmd`, icon `assets\chatgpt-fastlane.ico`, app id `com.openai.codex.fastlane` (what the patched copy registers via gate G5; lets a pinned taskbar button adopt the running window and keeps the entry's own name) | `--shortcut` (runs `shortcut.ps1`; `-Read` prints the entry) |

| `uninstall.cmd` | Quit the copy, delete the Start-menu entry and `build\`; keeps `~\.codex`, the profile and this folder. Only on the user's request | `--uninstall` |

Pinning to the taskbar or Start is a manual step for the user; Windows 11 refuses it from scripts. The Store package's own
tile, protocol handlers and Start entry stay as they are. The icon comes from `make-icon.mjs` (`npm run icon`): dark tile,
the package's white OpenAI mark, the Fysics Sub2API portrait (read from the fysics-infra repo next to this folder, or
`--portrait <png>`) and an amber bolt; change the constants at the top of that file, never edit the `.ico` by hand.

Dry run (patched `app.asar` and `ChatGPT.exe` only, no 2 GB copy): `node patch-codex-speed.mjs`.
Options: `--src <installed app folder>`, `--out <output app folder>`, `--verify-only`.

## How the patch works (enough to reason about failures)

1. **Locate:** `Get-AppxPackage -Name OpenAI.Codex` → `<InstallLocation>\app`; version from the folder name.
2. **Gates:** four checks in the renderer bundle (`webview/assets/app-initial-*.js` inside `resources/app.asar`) test the
   auth method (`chatgpt` / `personalAccessToken` / `amazonBedrock`) before showing the Speed picker or keeping
   `serviceTier` in a turn. Each is matched by a regex on those literals with the minified identifiers as wildcards
   (`GATES` in the script) and must match **exactly once** across all bundles; the match is rewritten to "always allowed".
   A fifth, optional gate (G5) changes the AppUserModelID in the main-process bundle to `com.openai.codex.fastlane`;
   if it matches nowhere the build continues with a warning and the Start-menu entry merges with the window as "ChatGPT".
3. **Repack:** the asar header and the patched file's integrity record are rebuilt; the new header hash is written over
   the old one inside `ChatGPT.exe` (PE resource `ElectronAsar/Integrity`, same length). The Electron fuses stay as they are.
4. **Copy:** with `--full-copy` the rest of the app folder is copied next to the patched files. The copy runs without
   package identity: its updater is inert, its profile is `%APPDATA%\Codex`, logs in `%LOCALAPPDATA%\Codex\Logs`;
   it shares `~/.codex` (config, sessions, log database) with the Store app.
5. **Verify:** exe hash equals header hash; patched strings present and originals absent; integrity of touched files;
   47 sampled untouched files re-hash correctly. Report: `build\<version>\report.json`. A build that fails verification
   exits 1 and must not be launched.

### macOS live mode (default for launch; verified 2026-11-03, ChatGPT 26.1027.61615, macOS 27.0)

`liveLaunch`: refuses if a patched copy runs, or if ChatGPT runs without a DevTools port (started normally; the user must
quit it). Computes G1–G4 on the installed `webview/assets/*.js` (aborts before starting anything if they do not match
exactly once), runs `open -a /Applications/ChatGPT.app --args --remote-debugging-port=0 --remote-debugging-address=127.0.0.1`,
reads the port from `~/Library/Application Support/Codex/DevToolsActivePort` and spawns the detached helper
(`--live-helper --port N`, pid in `build/live-helper.pid`, output in `build/launch.log`). The helper: browser-level
`Target.setAutoAttach {waitForDebuggerOnStart, flatten}`; per page session `Fetch.enable app://-/assets/*`, reload if
the page had loaded already, resume; `Fetch.requestPaused` → `fulfillRequest` with the patched bundle, otherwise
`continueRequest`. It exits when the DevTools socket closes (ChatGPT quit). Proof of work: `served patched …` lines in
`build/launch.log`, then `check-tier`. Never leave a DevTools port open on an app the user did not start through launch,
and never bind it to anything but 127.0.0.1.

**Windows live mode (opt-in `--launch --live`; passed on the PC 2026-11-03, Store app 26.1027.3384.0, docs/notes.md
section 12 "Windows test"):** same helper; the Store app is started with
`IApplicationActivationManager::ActivateApplication(<PackageFamilyName>!<AppId>, "<switches>")` (C# via PowerShell
`Add-Type`, see `WIN_ACTIVATE`) and keeps its package identity; the running app's switches are read from
`Win32_Process.CommandLine` (main process = no `--type=`). The port file is in Chromium's user-data folder, which on
Windows is `Codex\web\Codex` inside the profile: `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\Codex\web\Codex\DevToolsActivePort`
(`devToolsPortFiles` also tries `Codex\` and `%APPDATA%\Codex\…`). The engine runs from
`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, a copy the Store app makes of its own `resources\codex.exe`: to prove
which app sent a tier, check the engine's parent process, not its path. Computer Use picture-in-picture does not exist
on Windows in this version (every native PiP call is `darwin`-only), so do not chase it there. The `launch.cmd` default
stays the patched copy until the V1 cleanup makes live mode the only method.

### macOS patched copy (`--copy`, fallback)

1. **Locate:** `/Applications/ChatGPT.app` (or `~/Applications`) whose `CFBundleIdentifier` is `com.openai.codex`;
   version = `CFBundleShortVersionString`. "ChatGPT Classic.app" (`com.openai.chat`) is another app; ignore it.
2. **Gates:** identical; the same five regexes matched once each in this version.
3. **Seal, two places:** `Info.plist` `ElectronAsarIntegrity["Resources/app.asar"].hash` and the pin in
   `Codex Framework`'s section `__DATA_CONST,__asar_integrity` (sentinel `AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A`, 2 flag bytes,
   `sha256("Resources/app.asar" + "SHA256" + hash)`). Plist alone → "Failed to get integrity for validatable asar archive".
4. **Copy:** `cp -Rc` (APFS clone), then rewrite asar, plist (own bundle id `com.openai.codex.fastlane`, name, icon,
   `LSEnvironment CODEX_SPARKLE_ENABLED=false`) and framework; remove `embedded.provisionprofile`; `codesign --force
   --sign -` helpers, framework, app (no hardened runtime; restricted entitlements stripped). Profile and `~/.codex` are
   shared with the original (`~/Library/Application Support/Codex`), so the two must never run together.
5. **Verify:** as on Windows, plus plist hash and pin equal the header hash, and `codesign --verify --deep --strict`.

## When something fails

- **First read `build\launch.log`**: every run of the script appends what it printed there, including runs from the
  Start-menu entry whose console closes by itself. `launch.cmd` passes `--gui`, so refusals (Store app running,
  another copy running) and build errors also appear in a message box
- **"ChatGPT Fastlane launches but closes"** usually means the launcher ran and found the copy already running (it now
  brings the window to the front by starting the exe a second time, which Electron's single-instance lock turns into a
  focus request) or found the Store app running (message box; the user must quit it)

- **"gates could not be matched exactly once"** → OpenAI changed the code around that gate. Do not loosen the regex
  blindly. Extract the bundle ([docs/notes.md](docs/notes.md) section 2: read the asar header JSON, seek to the file's offset), search for
  `personalAccessToken`, `amazonBedrock`, `serviceTier`, read the surrounding function, then adjust only that gate's regex
  and `apply`. If the check is gone because upstream now supports speed tiers for custom providers, the patch is obsolete:
  tell the user instead of forcing it
- **"expected exactly 1 ElectronAsar integrity resource"** or **"integrity resource hash … does not match"** → the
  launcher format changed, or `--src` points at a mixed folder. Stop and report; do not guess
- **"Codex Store package not found"** → the app is not installed from the Store (or a different package name). Ask the
  user where the app is and pass `--src <folder containing ChatGPT.exe>`
- **Copy starts but shows no Speed submenu** → check that the Store app is not also running (profile lock), then
  `check-tier.cmd` after a test message. The UI alone proves nothing; the engine log is the source of truth
- **Store update does not appear in winget** → the Store updates in the background anyway; `launch.cmd` builds whatever
  version is installed. Otherwise Microsoft Store > Library > Get updates
- **A gate matches but the tier is still `default`** → the engine's `~/.codex/config.toml` must have
  `[features] fast_mode = true`, `ultrafast_mode = true` and a model catalog that lists the speed options
  ([docs/notes.md](docs/notes.md) section 6 has the redacted excerpt)
- **macOS: copy exits at once / crash report with `EXC_BREAKPOINT` in Codex Framework** → run
  `"build/<v>/ChatGPT Fastlane.app/Contents/MacOS/ChatGPT"` from a terminal for a few seconds and read the `FATAL` line.
  "Failed to get integrity" = plist hash and framework pin disagree; "Integrity check failed" = header hash differs.
  "expected exactly 1 __asar_integrity pin" = OpenAI changed the runtime's format: stop and report, do not guess
- **macOS: killed at launch with a code-signing reason** (Console, `AMFI`) → an entitlement that needs OpenAI's profile
  slipped through; extend `RESTRICTED_ENTITLEMENT`, never sign with someone else's identity
- **macOS live mode: "ChatGPT is running without Fastlane"** → ChatGPT was started normally (own Dock icon, restart after an
  update); the user quits it and uses the launcher. **"opened no DevTools port within 30 s"** → this version may block the
  port: report it, fall back to `--copy`. **Speed picker missing although the helper runs** → no `served patched` line in
  `build/launch.log`: the bundle URL changed (check `livePatches`' URL mapping)
- **macOS copy: no Computer Use picture-in-picture, "Invalid app: ChatGPT Fastlane", `dynamic_app_tools_peer_rejected`, "Sender
  process is not authenticated"** → known limit: these check OpenAI's team signature, which no modified copy can carry
  (README, macOS); use live mode. Do not patch the Computer Use service or the peer-authorization module to get around it

## Verifying a claim before reporting it

- Tier actually sent: `node check-tier.mjs <hours>` (reads `~/.codex/logs_2.sqlite`, i.e. `%USERPROFILE%\.codex` on Windows, table `logs`,
  column `feedback_log_body`, span `service_tier=`). Not the gateway's usage log: a group there may force a tier
- What is running and from where: `node patch-codex-speed.mjs --status`
- Which copy is which: the Store app runs from `\WindowsApps\` (macOS: `/Applications/ChatGPT.app`), the patched copy from
  `build\<version>\app\` (macOS: `build/<version>/ChatGPT Fastlane.app`)

## Keep this folder true

- When the script's flags, gates or layout change, update the table in README.md and this file in the same change
- Record test results with absolute dates (`2026-11-03`), never "today"
- The hand-over note for the fysics-infra sessions is outside this folder; the memory entry for Claude Code is
  "Codex desktop speed patch". Both point here; keep the entry points' names stable or update them too
- Remote `origin` is `git@github-jww03:jww03/chatgpt-fastlane.git`: the SSH alias `github-jww03` in `~\.ssh\config`
  uses the key `~\.ssh\id_ed25519_github_jww03` (GitHub account jww03, created 2026-11-03), not the PC's default GitHub
  credential (account jwwang2003). Plain `git push` works once that key is registered on the jww03 account; never change
  the alias to another key
