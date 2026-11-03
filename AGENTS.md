# Rules for agents working in this folder (Codex, Claude Code, others)

This folder is **ChatGPT Fastlane V1**: it starts the installed ChatGPT desktop app (OpenAI's Codex app, renamed ChatGPT;
Windows Store package `OpenAI.Codex`, macOS `/Applications/ChatGPT.app`, bundle id `com.openai.codex`) **patched in
memory**, so the Speed controls (Standard / Fast / Ultrafast) are shown and the chosen `service_tier` is sent for a custom
model provider. No file of the app is written, copied or re-signed: the app runs with a DevTools port on 127.0.0.1 and a
helper serves the gate-patched renderer bundle to its windows. V0 (2026-10-30 → 2026-11-03) built a patched copy of the
whole app; it was removed when live mode passed on both systems (docs/notes.md sections 11–13).
Read [README.md](README.md) for the overview and [docs/notes.md](docs/notes.md) for the full analysis; this file is the operating manual.

## What you may and may not do

- **Never write into** `C:\Program Files\WindowsApps\…` (the Store package) or `/Applications/ChatGPT.app` (macOS), and
  never `codesign`, `plutil` or `xattr` the installed app. V1 needs no file of the app changed; keep it that way
- **Never start, quit or kill the app without the user's OK in the conversation.** Launching is `launch.cmd` /
  `launch.command` or `--launch`; it refuses while ChatGPT runs normally (started without Fastlane). Say what is running
  and let the user quit it
- **DevTools port:** only ever on 127.0.0.1, only on an app started through launch, never with `--remote-allow-origins`.
  Do not leave a port open on an app the user did not start through Fastlane
- **Never delete `build\` by hand.** `cleanup` deletes V0 leftovers, `uninstall` deletes `build\`. Ask before either
- **No secrets anywhere in this folder.** `~/.codex/config.toml` holds a bearer token; quote it only with the value redacted.
  Never print or log API keys, tokens or the gateway key
- **Do not change the gateway or any server** from here. Tier behaviour on the gateway side (forced tiers per group) is
  documented in the fysics-infra repo (`docs/guests/bu01/ct121-sub2api.md`); changing it is a separate, approved task
- **Do not patch other OpenAI components** (the Computer Use service in `~/.codex/computer-use`, native modules, the engine)
- No Python on the Windows PC (the Mac has it, but keep the tooling Node-only). Use Node 22+ (global `WebSocket`; tested
  with 24). No npm packages; do not add any. Windows calls PowerShell; macOS calls `plutil`, `ps`, `open`, `osacompile`,
  `codesign` (launcher only), `osascript`

## Entry points (double-click, or run the script directly)

Each `.cmd` (Windows) has a `.command` twin (macOS, zsh, double-click in Finder) with the same flags.

| File | Does | Script call |
|---|---|---|
| `launch` | Start ChatGPT patched in memory, or bring it to the front | `node patch-codex-speed.mjs --launch --gui` |
| `update` | Windows: Microsoft Store update via winget (product `9PLM9XGG6VKS`), then launch, then status. macOS: explains that ChatGPT updates itself (Sparkle), then launch | `--store-update --launch` |
| `status` | Installed version, what runs, patched or not (port, helper), gates found, V0 leftovers | `--status` |
| (npm `check`) | Match the gates against the installed version, start nothing | `--check` |
| `check-tier` | Tier of each turn in the last 3 hours from the engine's log database | `node check-tier.mjs 3` |
| `shortcut` | Windows: Start-menu entry "ChatGPT Fastlane" → `launch.cmd` (`shortcut.ps1`, icon `assets\chatgpt-fastlane.ico`, AppUserModelID `ChatGPT.Fastlane.Launcher`; `-Read` prints it). macOS: `~/Applications/ChatGPT Fastlane.app` (`osacompile` applet running launch with the Node that created it) | `--shortcut` |
| `cleanup` | Show status, ask, delete V0 copies in `build\` (never a running one) | `--cleanup` (`--prune` still accepted) |
| `uninstall` | Stop the helper, delete the launcher and `build\`. Only on the user's request | `--uninstall` |

Pinning to the taskbar, Start or Dock is a manual step for the user. The icon comes from `make-icon.mjs` (`npm run icon`,
Windows: reads the Store package's logo): dark tile, the white OpenAI mark, the Fysics Sub2API portrait (from the
fysics-infra repo next to this folder, or `--portrait <png>`) and an amber bolt; change the constants at the top of that
file, never edit the `.ico` by hand. macOS builds its `.icns` from `assets/chatgpt-fastlane-256.png` at shortcut time.
Option for every mode: `--src <installed app folder>` (Windows: the `app` folder with `ChatGPT.exe`; macOS: the `.app`).

## How it works (enough to reason about failures)

1. **Locate:** Windows `Get-AppxPackage -Name OpenAI.Codex` → `<InstallLocation>\app`; macOS `/Applications/ChatGPT.app`
   (or `~/Applications`) whose `CFBundleIdentifier` is `com.openai.codex` ("ChatGPT Classic.app", `com.openai.chat`, is
   another app; ignore it).
2. **Gates:** four checks in the renderer bundle (`webview/assets/app-initial-*.js` inside `app.asar`, read only) test the
   auth method (`chatgpt` / `personalAccessToken` / `amazonBedrock`) before showing the Speed picker or keeping
   `serviceTier` in a turn. Each is matched by a regex on those literals with the minified identifiers as wildcards
   (`GATES` in the script) and must match **exactly once** across the renderer bundles; the match is rewritten to
   "always allowed" in memory. `launch` computes this before starting anything and stops if a gate does not match.
3. **Start with a port:** switches `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`. Windows:
   `IApplicationActivationManager::ActivateApplication(<PackageFamilyName>!<AppId>, "<switches>")` (C# via PowerShell
   `Add-Type`, `WIN_ACTIVATE`), so the app keeps its package identity. macOS: `open -a <app> --args <switches>`. The port
   is read from `DevToolsActivePort` in Chromium's user-data folder: macOS `~/Library/Application Support/Codex/`, Windows
   `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\Codex\web\Codex\` (the package's redirected profile; `devToolsPortFiles`
   also tries `Codex\` and `%APPDATA%\Codex\…`). Whether a running app has the switches: macOS `ps`, Windows
   `Win32_Process.CommandLine` of the main process (no `--type=`).
4. **Helper** (`--live-helper --port N`, detached; pid in `build/live-helper.pid`, output in `build/launch.log`):
   browser-level `Target.setAutoAttach {waitForDebuggerOnStart, flatten}`; per page session
   `Fetch.enable app://-/assets/*`, reload if the page had loaded already, resume; `Fetch.requestPaused` → `fulfillRequest`
   with the patched bundle, otherwise `continueRequest`. It exits when the DevTools socket closes (ChatGPT quit).

Platform facts: on Windows the engine runs from `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, a copy the Store app
makes of its own `resources\codex.exe`; to prove which app sent a tier, check the engine's parent process, not its path.
Computer Use picture-in-picture exists only on macOS (every native PiP call is `darwin`-only on Windows), so do not
chase it on Windows.

## When something fails

- **First read `build/launch.log`**: every run of the script appends what it printed there, including the helper and
  runs from the launcher whose console closes by itself. `launch` passes `--gui`, so refusals and errors also appear in a
  message box
- **"ChatGPT is running without Fastlane"** → ChatGPT was started normally (its own tile or Dock icon, a `codex://` link,
  its own restart after an update). The user quits it and uses the launcher
- **"A patched ChatGPT copy from Fastlane V0 is running"** → quit it; `cleanup` deletes the V0 copies
- **"gates could not be matched exactly once"** → OpenAI changed the code around that gate. Do not loosen the regex
  blindly. Extract the bundle ([docs/notes.md](docs/notes.md) section 2: read the asar header JSON, seek to the file's
  offset), search for `personalAccessToken`, `amazonBedrock`, `serviceTier`, read the surrounding function, then adjust
  only that gate's regex and `apply`; check with `--check`. If the check is gone because upstream now supports speed
  tiers for custom providers, Fastlane is obsolete: tell the user instead of forcing it
- **"opened no DevTools port within 30 s"** → first check whether the switches reached the app (command line, see
  above) and where `DevToolsActivePort` was written; the Windows location moved once already (`Codex\web\Codex`). If the
  app ignores the port, OpenAI has closed this route: stop and report. V0's patched copy is in git history
  (before tag `v1.0.0`) and docs/notes.md sections 1–11, but bringing it back loses package identity and, on macOS,
  everything that checks OpenAI's team signature; discuss it with the user first
- **Speed picker missing although the helper runs** → no `served patched` line in `build/launch.log`: the bundle URL
  changed (check `livePatches`' `app://-/` mapping)
- **A live start quits by itself after a few seconds** (seen once on Windows, 2026-11-03 21:35, after many forced quits;
  helper "served 0") → read that run's app log (Windows `%LOCALAPPDATA%\Codex\Logs\`, macOS `~/Library/Logs/com.openai.codex/`)
  first, then start once more
- **"Codex Store package not found"** → not installed from the Store (or another package name). Ask the user where the
  app is and pass `--src <folder containing ChatGPT.exe>`
- **Store update does not appear in winget** → the Store updates in the background anyway; launch patches whatever
  version is installed. Otherwise Microsoft Store > Library > Get updates
- **A gate matches but the tier is still `default`** → was Standard selected? Otherwise the engine's
  `~/.codex/config.toml` must offer the tier: Fast needs `priority` in the provider's model list; Ultrafast needs
  `[features] fast_mode = true`, `ultrafast_mode = true` and a model catalog listing `ultrafast`
  ([docs/notes.md](docs/notes.md) section 6 has the redacted excerpt)

## Verifying a claim before reporting it

- Tier actually sent: `node check-tier.mjs <hours>` (reads `~/.codex/logs_2.sqlite`, i.e. `%USERPROFILE%\.codex` on
  Windows, table `logs`, column `feedback_log_body`, span `service_tier=`). Not the gateway's usage log: a group there may
  force a tier. The UI alone proves nothing
- What is running, whether it is patched: `node patch-codex-speed.mjs --status`; that the patch reached the windows:
  `served patched …` lines in `build/launch.log`
- Whether the installed version can be patched, without starting it: `node patch-codex-speed.mjs --check`

## Keep this folder true

- When the script's flags, gates or layout change, update the table in README.md and this file in the same change
- Record test results with absolute dates (`2026-11-03`), never "today"
- The hand-over note for the fysics-infra sessions is outside this folder; the memory entry for Claude Code is
  "Codex desktop speed patch". Both point here; keep the entry points' names stable or update them too
- Remote `origin` is `git@github-jww03:jww03/chatgpt-fastlane.git` on both machines: the SSH alias `github-jww03` uses the
  key `~/.ssh/id_ed25519_github_jww03` (GitHub account jww03), not the machine's default GitHub credential (account
  jwwang2003). On the Mac the alias sits above `Include config.d/*.conf` with `ControlMaster no` / `ControlPath none`,
  because `config.d`'s `Host *` shares connections and a shared connection signed in as jwwang2003 would be reused; the
  same block also answers to the older name `github-personal`. Never point the alias at another key. When testing which
  account a key belongs to, pass `-o ControlMaster=no -o ControlPath=none`
