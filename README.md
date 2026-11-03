# ChatGPT Fastlane

Enables the **Speed** controls (Standard / Fast / Ultrafast) of the ChatGPT desktop app (OpenAI's Codex app, renamed
ChatGPT; Windows Store package `OpenAI.Codex`, macOS `/Applications/ChatGPT.app` with bundle id `com.openai.codex`) for a
**custom model provider**, and makes the app actually send the chosen `service_tier`. Windows and macOS, Node only,
no dependencies.

**V1 (2026-11-03): nothing is installed, copied or modified.** Fastlane starts the installed, OpenAI-signed app and
patches it **in memory** while it runs. The app keeps its signature, its package identity, its icon and its own
updates; every feature that checks OpenAI's signature keeps working. (V0 built a patched copy of the whole app; see
[docs/notes.md](docs/notes.md) for that history.)

> Unsupported and version-bound. It unlocks a UI gate for a feature the account already pays for; it does not change
> what the gateway or OpenAI serve. It may conflict with the app's terms of use. Use at your own risk.

## Why

The Codex app decides whether to show the Speed picker from the **auth method** (ChatGPT login, personal access token,
Amazon Bedrock), not from what the engine reports for the configured provider. With a custom `model_provider` the picker
is hidden and the tier in `config.toml` is dropped: the engine sends `service_tier = default` even with
`service_tier = "fast"` configured. Four checks in the renderer bundle cause this; the patch turns each into "allowed".

## Quick start

Requirements: the ChatGPT app (Windows: from the Microsoft Store; macOS: in `/Applications`), Node 22+ on `PATH`
(tested with Node 24).

1. Quit ChatGPT if it is running (Windows: tray icon too; macOS: Cmd-Q).
2. Start **`launch.cmd`** (Windows) or **`launch.command`** (macOS), or `npm run launch`. ChatGPT opens in about 5 s,
   already patched.
3. Choose a speed in the composer's model picker, send a message, then run **`check-tier.cmd`** / **`check-tier.command`**:
   it prints the tier of each recent turn from the engine's own log database, which is the proof (the UI alone is not).
4. Recommended: **`shortcut.cmd`** / **`shortcut.command`** creates a "ChatGPT Fastlane" launcher with its own icon
   (Windows: Start-menu entry; macOS: `~/Applications/ChatGPT Fastlane.app`). Start ChatGPT from there from now on.

**Start ChatGPT through Fastlane every time.** ChatGPT started any other way (its own tile or Dock icon, a `codex://`
link, the app's own restart after an update) runs unpatched; `launch` then refuses with a message: quit ChatGPT and use
the launcher. Clicking the launcher while ChatGPT Fastlane runs only brings ChatGPT to the front.

| Entry point (`.cmd` Windows, `.command` macOS) | `npm run` | Does |
|---|---|---|
| `launch` | `launch` | Start ChatGPT patched in memory, or bring it to the front. Refuses if ChatGPT runs normally. Output also in `build/launch.log` |
| `update` | `update` | Windows: ask the Microsoft Store for an update (winget, product `9PLM9XGG6VKS`), then launch, then status. macOS: explains that ChatGPT updates itself, then launch |
| `status` | `status` | Installed version, what runs, whether ChatGPT is patched (port, helper), whether the gates match, V0 leftovers |
| | `check` | Match the gates against the installed version without starting anything |
| `check-tier` | `tier` | Tier of each turn in the last 3 hours, from `~/.codex/logs_2.sqlite` |
| `shortcut` | `shortcut` | Create or refresh the "ChatGPT Fastlane" launcher |
| `cleanup` | `cleanup` | Delete patched copies Fastlane V0 left in `build/` (asks first; keeps anything running) |
| `uninstall` | `uninstall` | Stop the helper, remove the launcher, delete `build/` (asks first), see Uninstall |
| | `icon` | Regenerate `assets/chatgpt-fastlane.ico` from `make-icon.mjs` (Windows; reads the Store package) |

## How it works

1. **Locate** the installed app (`Get-AppxPackage -Name OpenAI.Codex`; macOS `/Applications/ChatGPT.app`, bundle id
   `com.openai.codex`) and read its renderer bundles from `app.asar` (read only).
2. **Match the gates** G1–G4 by regex on stable literals with the minified identifiers as wildcards; each must match
   exactly once, otherwise launch stops before starting anything and names the gate.
3. **Start the app with a DevTools port** on `127.0.0.1` (random port, `--remote-debugging-port=0`). Windows: by its
   AppUserModelID through `IApplicationActivationManager`, so it keeps its package identity; macOS: `open -a … --args`.
   The port is read from the profile's `DevToolsActivePort`.
4. **Helper.** A small Node process connects to that port and stays connected while ChatGPT runs. Every window's
   request for the renderer bundle (`app://-/assets/app-initial-*.js`) is answered with the gate-patched bytes (DevTools
   `Fetch` domain). New windows are held until interception is on; the main window, which loads before the helper
   connects, is reloaded once. The helper exits when ChatGPT quits.

Costs: while ChatGPT runs this way, any local process of yours can drive the app through the DevTools port (web pages
cannot: no remote origins are allowed). An app update can move the gate code (launch then names the gate) or, in
principle, stop accepting the port (launch then says so); see `AGENTS.md`, "When something fails".

## After an app update

Nothing to rebuild. The Store (Windows) or ChatGPT itself (macOS, Sparkle) updates the app as usual; the next launch
patches whatever version is installed. An update restarts ChatGPT unpatched: quit it and start it through the launcher.

## Engine-side requirements

The engine must know the speed options too. Fast appears when the provider's model list offers `priority` (on the Mac
tested, the gateway's list does). For **Ultrafast**, `~/.codex/config.toml` needs `[features] fast_mode = true`,
`ultrafast_mode = true` and a `model_catalog_json` that lists an `ultrafast` service tier for the models you use
(redacted example in [docs/notes.md](docs/notes.md), section 6; back up `config.toml` first; the catalog freezes the model
list). Whether Fast or Ultrafast changes anything after that depends on the gateway and the account behind it.

## Platform notes

- **Windows** (tested 2026-11-03, Store app 26.1027.3384.0): the port file is in Chromium's user-data folder inside the
  package's redirected profile, `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\Codex\web\Codex\`.
  The engine runs from a copy the Store app makes itself (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`). Computer
  Use picture-in-picture does not exist in the Windows app (macOS-only code), patched or not.
- **macOS** (tested 2026-11-03, ChatGPT 26.1027.61615, macOS 27.0): "ChatGPT Classic.app" (`com.openai.chat`) is a
  different app and is ignored. Computer Use picture-in-picture, the app's own tools (`codex_app`) and everything else
  work as in the normal app.

## Launcher and icon

The launcher carries the Fastlane icon (`assets/`), composed by `make-icon.mjs` like the Codex tile: a dark rounded
square with the app's own white OpenAI mark, the Fysics Sub2API portrait circle as a badge (the gateway the speed tiers
go through; default source `../fysics-infra/asset_images/fysics_sub2api/sub2api_portrait.png`, or `--portrait <png>`)
and an amber lightning bolt. The ChatGPT window itself keeps the app's own icon and taskbar/Dock button.

- Windows: `shortcut.cmd` writes `%APPDATA%\Microsoft\Windows\Start Menu\Programs\ChatGPT Fastlane.lnk` (runs `launch.cmd`
  minimised, its own AppUserModelID so Windows does not merge it with the Store app's tile). Pin it by hand: Start → type
  **ChatGPT Fastlane** → right-click → **Pin to taskbar** (Windows 11 does not allow scripts to pin).
- macOS: `shortcut.command` writes `~/Applications/ChatGPT Fastlane.app` (an AppleScript app running launch with the Node
  that created it; run `shortcut` again if Node moves). Drag it to the Dock.

## Upstream

The durable fix is upstream, in github.com/openai/codex: derive speed-tier access from the engine's
`configRequirements/read` and `model/list` instead of the auth method.

## Layout

```
patch-codex-speed.mjs   locate, match the gates, launch with the DevTools port, the helper, status, shortcut, cleanup
check-tier.mjs          service tier per turn from the engine's log database
*.cmd / *.command       double-click entry points for Windows / macOS (table above)
shortcut.ps1            writes the Windows Start-menu entry (IShellLink + AppUserModelID); -Read prints it
make-icon.mjs, assets/  the icon (generator and output)
AGENTS.md / CLAUDE.md   operating manual for LLM agents working in this folder
docs/notes.md           the investigation: gates with code excerpts, V0 (patched copy), V1 (live mode), test results
build/                  launch.log and the helper's pid file, ignored by git
```

## Uninstall

`uninstall.cmd` / `uninstall.command` (or `npm run uninstall`) stops the helper, removes the launcher and deletes
`build/` (including any V0 copies). ChatGPT keeps running and is the normal app from its next start; it was never
changed. Then, by hand: unpin the launcher from the taskbar or Dock, and delete this folder if you do not want the
scripts any more. Kept on purpose: `~/.codex` (config, sessions, log database). If you also want to undo the engine-side
settings made for the speed tiers (`service_tier`, `[features]`, `model_catalog_json` in `config.toml`), the Windows PC's
backups from 2026-10-30 are in `~\.codex\backups\speed-settings-2026-10-30T07-18-41-033Z\`.

V0 leftovers outside this folder, if you used it: Windows `%APPDATA%\Codex` and `%LOCALAPPDATA%\Codex\Logs` (the copy's
own profile and logs); macOS `~/Library/Logs/com.openai.codex.fastlane`. Delete them by hand if unwanted.
