# ChatGPT Fastlane

Enables the **Speed** controls (Standard / Fast / Ultrafast) of the ChatGPT desktop app (OpenAI's Codex app, renamed
ChatGPT in the Microsoft Store; the package is still `OpenAI.Codex`, on macOS `/Applications/ChatGPT.app` with bundle id
`com.openai.codex`) for a **custom model provider**, and makes the app actually send the chosen `service_tier`. On Windows
it builds a patched **copy** of the installed app; on macOS it patches the running official app in memory (live mode, a
patched copy is the fallback). The installation itself is never modified. Windows and macOS
([macOS section](#macos)), Node only, no dependencies.

> Unsupported and version-bound. It unlocks a UI gate for a feature the account already pays for; it does not change
> what the gateway or OpenAI serve. It may conflict with the app's terms of use. Use at your own risk.

## Why

The Codex app decides whether to show the Speed picker from the **auth method** (ChatGPT login, personal access token,
Amazon Bedrock), not from what the engine reports for the configured provider. With a custom `model_provider` the picker
is hidden and the tier in `config.toml` is dropped: the engine sends `service_tier = default` even with
`service_tier = "fast"` configured. Four checks in the renderer bundle cause this; the patch turns each into "allowed".

## Quick start (Windows; macOS: see [macOS](#macos))

Requirements: Windows 10/11, the Codex app from the Microsoft Store, Node 18+ on `PATH` (tested with Node 24),
about 2 GB of free disk per app version.

1. Quit the Store app completely (tray icon too).
2. Double-click **`launch.cmd`**. The first run builds `build\<version>\app\` (a few minutes) and starts it.
3. In the composer's model picker, choose a speed. Send a message, then run **`check-tier.cmd`**: it prints the tier of
   each recent turn from the engine's own log database, which is the proof (the UI alone is not).

Everything else is the same script with other flags (each `.cmd` has a macOS twin `.command` with the same name):

| Entry point | `npm run` | Does |
|---|---|---|
| `launch.cmd` | `launch` | Build the installed version if not built yet, then start the copy. If the copy already runs, brings its window to the front; if the Store app runs, says so in a message box. Output also goes to `build\launch.log` |
| `update.cmd` | `update` | Ask the Microsoft Store for an update (winget, product `9PLM9XGG6VKS`), build the new version if needed, start it, print status |
| `patch.cmd` | `patch` | Build only, start nothing |
| `status.cmd` | `status` | Installed version, builds and their verification state, what is running, stale builds |
| `cleanup.cmd` | `cleanup` | Delete builds of other versions (asks first; keeps the installed version's build and anything running) |
| `check-tier.cmd` | `tier` | Tier of each turn in the last 3 hours, from `~/.codex/logs_2.sqlite` (`%USERPROFILE%\.codex` on Windows) |
| `shortcut.cmd` | `shortcut` | Create or refresh the Start-menu entry "ChatGPT Fastlane" (icon + application id), see below |
| `uninstall.cmd` | `uninstall` | Quit the copy, remove the Start-menu entry, delete `build\` (asks first), see Uninstall |
| | `verify` | Re-verify the current build without rebuilding |
| | `icon` | Regenerate `assets\chatgpt-fastlane.ico` from `make-icon.mjs` |

Dry run without the 2 GB copy: `node patch-codex-speed.mjs` (writes only the patched `app.asar` and `ChatGPT.exe`).
Options: `--src <installed app folder>`, `--out <output folder>`.

## Start menu, taskbar and icon

`shortcut.cmd` creates the Start-menu entry **ChatGPT Fastlane** (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\ChatGPT Fastlane.lnk`):
it runs `launch.cmd` in a minimised console, carries the icon `assets\chatgpt-fastlane.ico` and the application id
`com.openai.codex.fastlane`. The patched copy registers that same id (gate G5 changes the app's own `com.openai.codex`;
with the shared id Windows merged the entry with the running window under the name "ChatGPT"). Nothing in the Store
package changes, so the Store keeps updating it; the launcher builds the new version on the next start.

The copy itself has no icon: Store apps keep theirs in the package manifest, and `ChatGPT.exe` carries none, so its
taskbar button shows a blank page. Pin the entry once and the taskbar uses the icon from then on: Start → type
**ChatGPT Fastlane** → right-click → **Pin to taskbar** (and, if you like, **Pin to Start**; unpin the Store app's tile).
Because the ids match, the running window groups onto the pinned button. Windows 11 does not allow scripts to pin, so
this is the one manual step.

The icon is composed by `make-icon.mjs` like the Codex Start-menu tile: a dark rounded square with the app's own white
OpenAI mark (`assets\Square44x44Logo.targetsize-256_altform-unplated.png` from the installed package), the Fysics
Sub2API portrait circle as a badge (the gateway the speed tiers go through; default source
`..\fysics-infra\asset_images\fysics_sub2api\sub2api_portrait.png`, or `--portrait <png>`) and an amber lightning bolt.
`npm run icon` regenerates it; the generated `.ico` is committed, the sources are only read.
Protocol links (`codex://`, the browser extension) still open the Store app; that association lives in the package.

## After an app update

Nothing to maintain by hand. The script locates the installed package each run and builds into `build\<version>\app`,
so a new version simply gets a new folder: run `launch.cmd` (the Store updates in the background) or `update.cmd`
(checks the Store first). Then `cleanup.cmd` removes the old build.

The four gates are matched by regular expressions on the parts of the code that are stable across builds (the string
literals `chatgpt`, `personalAccessToken`, `amazonBedrock`, `.serviceTier`), with the minified identifiers as
wildcards. Each gate must match exactly once; otherwise the build **aborts and names the gate**, which means OpenAI
changed that code and the pattern has to be re-derived (see `AGENTS.md`, "When something fails").

## How it works

1. **Locate** the package with `Get-AppxPackage -Name OpenAI.Codex`.
2. **Patch** the four speed gates inside `resources\app.asar` (renderer bundle `webview\assets\app-initial-*.js`) and,
   optionally, the application id in the main-process bundle (gate G5, so the copy has its own Start-menu and taskbar
   identity; skipped with a warning if the code moved).
3. **Repack** the asar: new header, new integrity record for the patched file, duplicates kept deduplicated.
4. **Re-seal** the launcher: the app is built with Electron's asar-integrity fuse on, and the expected header hash is a
   PE resource inside `ChatGPT.exe`. The new hash is written over the old one, same length. The fuses stay untouched.
5. **Copy** the rest of the app folder next to the patched files and **verify** (hash equality, patched strings present
   and originals absent, file integrity, a sample of untouched files). Report: `build\<version>\report.json`.

The copy runs without package identity: its own updater is inert, its profile lives in `%APPDATA%\Codex` and it shares
`~\.codex` (config, sessions, log database) with the Store app. Never run both at the same time.

## Engine-side requirements

The engine must know the speed options too. In `~\.codex\config.toml`: `[features] fast_mode = true`,
`ultrafast_mode = true`, and a model catalog that lists the speed options for the models you use (redacted example in
[docs/notes.md](docs/notes.md), section 6). Whether Fast or Ultrafast changes anything after that depends on the gateway
and the account behind it.

## macOS

Tested 2026-11-03 on macOS 27.0 (Apple silicon) with ChatGPT 26.1027.61615 (`/Applications/ChatGPT.app`, bundle id
`com.openai.codex`; "ChatGPT Classic.app", `com.openai.chat`, is a different app and is ignored). Requirements: Node 18+
(22.5+ for `check-tier`); `codesign`, `plutil` and `osacompile` ship with macOS.

### Live mode (what `launch` does on macOS)

No file is changed and nothing is built. `launch` starts the installed, OpenAI-signed `/Applications/ChatGPT.app` with
a DevTools port on `127.0.0.1` (random port) plus a small helper process. While ChatGPT runs, the helper answers the
windows' requests for the renderer bundle with the gate-patched version (gates G1–G4, computed from the installed app at
every launch). Windows opened later are held until interception is on; the main window, which loads before the helper
connects, is reloaded once. Because the app keeps OpenAI's signature, everything that checks it keeps working: Computer
Use picture-in-picture and its menu, the app's own tools (`codex_app`), keychain, notifications, `codex://` links, and
the app's own updates (Sparkle). After an update the next launch simply patches the new version.

1. Quit ChatGPT (Cmd-Q) if it is running normally; `launch` refuses to touch an app it did not start.
2. Double-click **`launch.command`** (or `npm run launch`): ChatGPT opens in about 5 s, already patched.
3. Choose a speed in the composer's model picker, send a message, run **`check-tier.command`**.
4. Recommended: **`shortcut.command`** creates `~/Applications/ChatGPT Fastlane.app` (Fastlane icon) that runs launch; keep
   it in the Dock and start ChatGPT from there. ChatGPT started any other way (its own Dock icon, Spotlight, a
   `codex://` link, a restart after an update) runs unpatched: quit it and use the launcher. Clicking the launcher while
   ChatGPT Fastlane runs only brings ChatGPT to the front.

Costs: while ChatGPT runs this way, any local process of yours can drive the app through the DevTools port (web pages
cannot: no remote origins are allowed). The helper exits when ChatGPT quits. `status` shows the live state.

On Windows the same live mode is in the script but **experimental and untested** (opt-in:
`node patch-codex-speed.mjs --launch --live --gui`): it starts the Store app by its AppUserModelID with the same two
switches (`IApplicationActivationManager`, so the app keeps its package identity) and reads the port from
`%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\Codex\DevToolsActivePort`. If it passes on the
PC it replaces the 2 GB copy there too.

### Patched copy (fallback, `--copy`)

The approach used on Windows also works on macOS, with fewer features: `node patch-codex-speed.mjs --full-copy --if-needed
--launch --copy` (build only: `patch.command`) builds `build/<version>/ChatGPT Fastlane.app` (about 15 s, ~1 GB of new
data; the rest is an APFS clone of the installed app) and opens it. Use it only if live mode stops working (for example
if a future version ignores the DevTools port). The copy and ChatGPT share `~/Library/Application Support/Codex` and
`~/.codex`; never run both.

The `.command` files mirror the `.cmd` files one to one (`launch`, `update`, `patch`, `status`, `cleanup`,
`check-tier`, `shortcut`, `uninstall`); `npm run …` and the script flags are the same on both systems.

What the copy needs beyond Windows:

- **Two seals instead of one.** The expected asar header hash is in `Info.plist` (`ElectronAsarIntegrity`) *and* pinned
  in OpenAI's runtime: `Codex Framework` has a 66-byte Mach-O section `__DATA_CONST,__asar_integrity` = 32-char sentinel,
  two flag bytes, `sha256("Resources/app.asar" + "SHA256" + hash)`. Changing only the plist aborts at start with
  "Failed to get integrity for validatable asar archive". The script rewrites both and checks the old values first.
- **Re-signing.** The modified bundle is signed ad hoc, inside-out (helpers, framework, app), without hardened runtime,
  keeping each part's entitlements minus those only OpenAI's provisioning profile can grant (application identifier,
  push, associated domains, keychain and app groups); the profile is removed. Gatekeeper's `spctl` rejects an ad-hoc
  app, but a locally built copy carries no quarantine flag and opens normally.
- **Own identity.** Bundle id `com.openai.codex.fastlane` (gate G5 sets the same id inside the app, which on macOS names
  the log folder `~/Library/Logs/com.openai.codex.fastlane`), name "ChatGPT Fastlane", the Fastlane icon, and
  `LSEnvironment CODEX_SPARKLE_ENABLED=false` so the copy never updates itself into an unpatched app.
- **Updates.** There is no Store: ChatGPT updates itself (Sparkle). `update.command` explains this; in live mode nothing
  else is needed, with `--copy` the next launch builds the new version and `cleanup` removes the old one.
- **Known limits of the copy: anything that checks OpenAI's signature** (live mode has none of these). Any patched copy loses OpenAI's team signature
  (2DC432GLL2), and two features insist on it. (1) The app's own tool pipe (`codex_app`, e.g. "Inspect the active Codex
  window") authorises callers by the team id of the caller, its parent and grandparent (`browser-use-peer-authorization.node`);
  the engine's parent is the ad-hoc copy, so the log shows `dynamic_app_tools_peer_rejected reason=missing-code-signing-identity`.
  (2) The Computer Use service (`~/.codex/computer-use`, OpenAI-signed) authorises the requesting app by team id, so the
  copy gets "Sender process is not authenticated": **no Computer Use picture-in-picture preview** and no Computer Use menu
  state. Computer Use *tools* on other apps still work (the engine that calls them is unmodified and OpenAI-signed). Push notifications, keychain-shared ChatGPT sign-in and
  `codex://` links (they open the original) depend on OpenAI's signature as well. macOS asks again for privacy permissions
  (microphone, automation, …) for the copy, and again after a rebuild.
- **Ultrafast (both macOS modes)** needs the engine side as on Windows ([Engine-side requirements](#engine-side-requirements)). On the Mac
  tested, the gateway's model list (`~/.codex/models_cache.json`) offers only `priority`, so the picker shows Standard and
  Fast; for Ultrafast add `[features] fast_mode = true` / `ultrafast_mode = true` and a `model_catalog_json` whose models
  list an `ultrafast` service tier (back up `config.toml` first; the catalog freezes the model list).

## Upstream

The durable fix is upstream, in github.com/openai/codex: derive speed-tier access from the engine's
`configRequirements/read` and `model/list` instead of the auth method.

## Layout

```
patch-codex-speed.mjs   locate, patch, repack, re-seal, copy, verify, Store update, status, prune, launch
check-tier.mjs          service tier per turn from the engine's log database
*.cmd                   double-click entry points (table above)
*.command               the same entry points for macOS (Finder double-click, Terminal)
shortcut.ps1            writes the Start-menu entry (IShellLink + AppUserModelID); -Read prints it
make-icon.mjs, assets/  the icon (generator and output)
AGENTS.md / CLAUDE.md   operating manual for LLM agents working in this folder
docs/notes.md           the investigation: gates with code excerpts, exact replacements, test results, measurements
build/                  build output, ignored by git (one full app copy per version; macOS: build/<version>/ChatGPT Fastlane.app)
```

## Uninstall

`uninstall.cmd` (or `npm run uninstall`) quits the patched copy, removes the Start-menu entry and deletes `build\`
(the 2 GB copies and `launch.log`). Then, by hand:

- unpin "ChatGPT Fastlane" from the taskbar or Start if you pinned it;
- delete this folder if you do not want the scripts any more;
- optionally delete the copy's own profile `%APPDATA%\Codex` (window state, caches of the unpackaged copy; the Store
  app's profile is elsewhere, under `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0`) and `%LOCALAPPDATA%\Codex\Logs`.

Kept on purpose: `~\.codex` (config, sessions, log database, shared with the Store app). If you also want to undo the
engine-side settings made for the speed tiers (`service_tier`, `[features]`, `model_catalog_json` in `config.toml`),
the backups from 2026-10-30 are in `~\.codex\backups\speed-settings-2026-10-30T07-18-41-033Z\`.

The Store installation was never changed; if it misbehaves, repair or reset it from Settings → Apps → ChatGPT →
Advanced options.

macOS: `uninstall.command` stops the live helper (ChatGPT keeps running and is unpatched from its next start), quits a running copy and deletes `~/Applications/ChatGPT Fastlane.app` and `build/`; remove the
launcher from the Dock yourself. Kept: `~/.codex` and `~/Library/Application Support/Codex` (both shared with ChatGPT),
`~/Library/Logs/com.openai.codex.fastlane` (delete by hand if unwanted). `/Applications/ChatGPT.app` was never changed.
