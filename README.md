# Codex Fastlane

Enables the **Speed** controls (Standard / Fast / Ultrafast) of the Codex desktop app for a **custom model provider**,
and makes the app actually send the chosen `service_tier`. It does so by building a patched **copy** of the installed
Microsoft Store app; the installation itself is never modified. Windows only, Node only, no dependencies.

> Unsupported and version-bound. It unlocks a UI gate for a feature the account already pays for; it does not change
> what the gateway or OpenAI serve. It may conflict with the app's terms of use. Use at your own risk.

## Why

The Codex app decides whether to show the Speed picker from the **auth method** (ChatGPT login, personal access token,
Amazon Bedrock), not from what the engine reports for the configured provider. With a custom `model_provider` the picker
is hidden and the tier in `config.toml` is dropped: the engine sends `service_tier = default` even with
`service_tier = "fast"` configured. Four checks in the renderer bundle cause this; the patch turns each into "allowed".

## Quick start

Requirements: Windows 10/11, the Codex app from the Microsoft Store, Node 18+ on `PATH` (tested with Node 24),
about 2 GB of free disk per app version.

1. Quit the Store app completely (tray icon too).
2. Double-click **`launch.cmd`**. The first run builds `build\<version>\app\` (a few minutes) and starts it.
3. In the composer's model picker, choose a speed. Send a message, then run **`check-tier.cmd`**: it prints the tier of
   each recent turn from the engine's own log database, which is the proof (the UI alone is not).

Everything else is the same script with other flags:

| Entry point | `npm run` | Does |
|---|---|---|
| `launch.cmd` | `launch` | Build the installed version if not built yet, then start the copy. If the copy already runs, brings its window to the front; if the Store app runs, says so in a message box. Output also goes to `build\launch.log` |
| `update.cmd` | `update` | Ask the Microsoft Store for an update (winget, product `9PLM9XGG6VKS`), build the new version if needed, start it, print status |
| `patch.cmd` | `patch` | Build only, start nothing |
| `status.cmd` | `status` | Installed version, builds and their verification state, what is running, stale builds |
| `cleanup.cmd` | `cleanup` | Delete builds of other versions (asks first; keeps the installed version's build and anything running) |
| `check-tier.cmd` | `tier` | Tier of each turn in the last 3 hours, from `%USERPROFILE%\.codex\logs_2.sqlite` |
| `shortcut.cmd` | `shortcut` | Create or refresh the Start-menu entry "Codex Fastlane" (icon + application id), see below |
| | `verify` | Re-verify the current build without rebuilding |
| | `icon` | Regenerate `assets\codex-fastlane.ico` from `make-icon.mjs` |

Dry run without the 2 GB copy: `node patch-codex-speed.mjs` (writes only the patched `app.asar` and `ChatGPT.exe`).
Options: `--src <installed app folder>`, `--out <output folder>`.

## Start menu, taskbar and icon

`shortcut.cmd` creates the Start-menu entry **Codex Fastlane** (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codex Fastlane.lnk`):
it runs `launch.cmd` in a minimised console, carries the icon `assets\codex-fastlane.ico` and the application id
`com.openai.codex.fastlane`. The patched copy registers that same id (gate G5 changes the app's own `com.openai.codex`;
with the shared id Windows merged the entry with the running window under the name "ChatGPT"). Nothing in the Store
package changes, so the Store keeps updating it; the launcher builds the new version on the next start.

The copy itself has no icon: Store apps keep theirs in the package manifest, and `ChatGPT.exe` carries none, so its
taskbar button shows a blank page. Pin the entry once and the taskbar uses the icon from then on: Start → type
**Codex Fastlane** → right-click → **Pin to taskbar** (and, if you like, **Pin to Start**; unpin the Store app's tile).
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

## Other platforms

The gate patch and the asar rebuild are plain JavaScript and would work anywhere. The sealing is OS-specific: on macOS
the hash lives in `Info.plist` (`ElectronAsarIntegrity`) and the bundle would need re-signing; the script implements
Windows only. The durable fix is upstream, in github.com/openai/codex: derive speed-tier access from the engine's
`configRequirements/read` and `model/list` instead of the auth method.

## Layout

```
patch-codex-speed.mjs   locate, patch, repack, re-seal, copy, verify, Store update, status, prune, launch
check-tier.mjs          service tier per turn from the engine's log database
*.cmd                   double-click entry points (table above)
shortcut.ps1            writes the Start-menu entry (IShellLink + AppUserModelID); -Read prints it
make-icon.mjs, assets/  the icon (generator and output)
AGENTS.md / CLAUDE.md   operating manual for LLM agents working in this folder
docs/notes.md           the investigation: gates with code excerpts, exact replacements, test results, measurements
build/                  build output, ignored by git (one full app copy per version)
```

## Revert

Delete `build\`. The Store installation was never changed; if it misbehaves, repair or reset it from
Settings → Apps → Codex → Advanced options.
