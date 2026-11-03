# Investigation notes and log (2026-10-30 → 2026-11-03)

The long form behind [the project README](../README.md): feasibility, the four gates with code excerpts, the exact
replacements for 26.1027.3384.0, test results, the Ultrafast gateway test and the fast-mode measurement. Section
numbers are referenced from `AGENTS.md`. Paths are as they were on the PC where this was done.

---

## 0. Original summary

Investigation of 2026-10-30 on this PC. App: Microsoft Store package `OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0`
(app version 26.1027.30824, Electron-style "owl" runtime on Chromium 156). Provider: the Sub2API gateway at
`http://172.16.50.88:8091`, provider name `OpenAI`, in `C:\Users\wjw\.codex\config.toml`.

**Status (2026-10-30, 16:15):** patch built, launched and **verified end to end** (section 7). The launchable copy is
`build\app\` (all 3 619 files of the installed app; only `resources\app.asar` and the integrity value inside `ChatGPT.exe`
differ, `chrome.dll` and the engine binaries hash identically). Nothing in the installed Store app was changed.

This is unsupported, version-specific (minified names and the file hash change on every update), will stop working
at the next app update, and may conflict with the app's terms of use. It is a UI unlock for a feature your account
already pays for; it does not change what the gateway or OpenAI serve.

## 1. Feasibility

| Check | Result |
|---|---|
| Electron fuses (sentinel in `app\chrome.dll`, the runtime; `ChatGPT.exe` is only a 4.7 MB launcher) | `EnableEmbeddedAsarIntegrityValidation` **on**, `OnlyLoadAppFromAsar` **on**, `EnableCookieEncryption` on; `RunAsNode` **off**, `EnableNodeOptionsEnvironmentVariable` **off**, `EnableNodeCliInspectArguments` **off** |
| asar integrity data | Every one of the 22 423 files in `app.asar` carries a SHA256 + 4 MiB block hashes in the header. The header itself is hashed into a PE resource of `ChatGPT.exe`: type `ElectronAsar`, name `Integrity`, 122 bytes at file offset 4 690 112: `[{"file":"resources\\app.asar","alg":"SHA256","value":"58b11f64…9d85"}]`. The value is `sha256(header JSON)` and matches the installed asar (verified). |
| Package folder writable? | No. `C:\Program Files\WindowsApps\…` is ACL-protected (write test: permission denied). The package is Store-signed (`SignatureKind: Store`, not developer mode). |
| Copying files out of the package folder | Works (Node `fs.cpSync`, tested on sub-folders). |

**Conclusion.** A clean in-place patch is not possible: the folder is read-only and even if it were, the package
signature and the Store's repair logic would fight it. A modified `app.asar` alone also fails, because the runtime
compares the header hash with the resource in `ChatGPT.exe` and aborts.

What *is* feasible, and what the script does: a **patched copy of the whole app folder** outside `WindowsApps`
(about 2 GB), with (a) the rebuilt `app.asar` and (b) a `ChatGPT.exe` whose 64-hex integrity value is overwritten in
place with the new header hash (same length, so no PE relayout). Run the copy's `ChatGPT.exe` instead of the Store app.

Alternatives considered:

- **Runtime injection with `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`:** blocked by the fuses above.
- **Chrome DevTools Protocol (`--remote-debugging-port`) + `Fetch` interception** of `app://-/assets/app-initial-*.js`
  to serve the patched bundle without touching any file: plausible (the assets are served by a `protocol.handle("app", …)`
  handler in the main process), but untested, and the Store app would have to be started with that flag every time.
- **User script / extension:** not possible; the gates are inside module scope of a minified bundle.
- **Upstream fix:** the previous audit already pointed at the open issues on github.com/openai/codex
  (catalog omission for API-key users, 52296 / 52839). Waiting for that is the only supported route.

## 2. The gates (bundle `webview/assets/app-initial-4267e52fe5b0.js`)

Helper semantics (bindings `Wt`, `Cc`, `Aee` in this bundle are the app-shared functions `tht`, `cht`, `nht`; inferred from use):

- `tht(configRequirementsResponse)` → access object `{fast, ultrafast}`: `fast = featureRequirements.fast_mode !== false`,
  `ultrafast = (supportsIndependentSpeedModes === true || fast) && featureRequirements.ultrafast_mode !== false`.
  The engine's `configRequirements/read` already answers `supportsIndependentSpeedModes: true` here, so access would be
  `{fast: true, ultrafast: true}` if anyone asked.
- `nht(tier, access)` → allowed? (`default`/null always; otherwise `access[fast|ultrafast]`); `cht(model, tier, access)` resolves
  the tier to send, `null` when not allowed.
- The composer shows the picker when `serviceTierAccess != null && availableOptions.length > 1`
  (`app-primary-998934e837fc.js` @4355116), and `availableOptions` comes from `model/list`'s `serviceTiers` filtered by `nht`.

The engine lists Fast and Ultrafast for both models (your catalog override), so the only thing that returns `null` for a
custom provider is the auth-method test in four places:

**G1 — UI hook `VAo` (@7837549).** `Ik(hostId).authMethod` is `chatgpt` / `personalAccessToken` / `amazonBedrock` / `apikey` /
`null`; with the custom provider (`requires_openai_auth = false`, bearer token, no account) it is `null`.

```js
function VAo(e){let t=(0,HAo.c)(10),n=uo(bD),r=e?.hostId??n,i=Ik(r),
a=i?.authMethod===`chatgpt`||i?.authMethod===`personalAccessToken`||i?.authMethod===`amazonBedrock`,o=i?.authMethod??null,s;
…let{data:c,isPending:l}=_s(TO,s),u=!!i?.isLoading||a&&l,d;
…d=a&&!u&&c!=null?Wt(c):null … return {serviceTierAccess:f,isLoading:u}
```

`a` false → `serviceTierAccess` is `null` → picker hidden, every option filtered out. The `TO` query (`configRequirements/read`)
runs regardless of `a`, so forcing `a` true is enough for the UI.

**G2 — request-time resolver `kzs` (@9489479)**, called by `Ozs`, which fills `serviceTier` in `create_thread` and in each turn submission (@9501076, @9508207):

```js
async function kzs(e,t){let n=await Tzs(e,t);
if(n!==`chatgpt`&&n!==`personalAccessToken`&&n!==`amazonBedrock`)return null;
let r=await dNn(e,t,{priority:`critical`});return e.query.setData(TO,{authMethod:n,hostId:t},r),Wt(r)}
```

`Tzs` returns the auth method (`getAuthMethod`, else `account.type` mapped by `Ezs`). Anything else → `null` access → `cht` drops the tier.

**G3 — turn preparation `Ymn` (@3164682)**, the `prepare` step of the turn coordinator, which builds the `turn/start` parameters:

```js
let[b,x]=await Promise.all([(async()=>{if(u==null)return a(m?.latestModel||null);if(u.serviceTier==null)return null;
let{account:t}=await e.getAccount({priority:`critical`});
return t?.type===`chatgpt`||t?.type===`amazonBedrock`?u.serviceTier:null})(), …]);
… let S={conversationId:c,…,model:null,serviceTier:b,…}
```

Even when G2 lets a tier through in `submissionOptions` (`u`), this drops it unless the account is ChatGPT or Bedrock. With no
`submissionOptions` it calls `a` = `readServiceTier` from G4.

**G4 — default turn config `Xun.readServiceTier` (@2970241)**, used by the queued-message path:

```js
return n(),Jun(e.requestClient,e.logger,r,async()=>{
if(e.getHostId()===`local`&&await t.isUsingCopilotInference())return!1;
let n=await e.getAccount({priority:`critical`});
return n.account?.type===`chatgpt`||n.account?.type===`amazonBedrock`})
```

`Jun` returns `null` when that callback is false; otherwise it reads `configRequirements/read` → `tht`, then `config.service_tier`
(your `service_tier = "fast"`) → `cht(null, "fast", access)` → `"fast"`.

The previous Codex audit named G1 and G2 (plus `Ozs`); G3 and G4 are additional and would silently drop the tier at send time.

## 3. The patch (exact replacements, all in `app-initial-4267e52fe5b0.js`, each old string occurs exactly once)

| Gate | old → new |
|---|---|
| G1 | `a=i?.authMethod===\`chatgpt\`\|\|…\|\|i?.authMethod===\`amazonBedrock\`,o=i?.authMethod??null` → `a=!0\|\|i?.authMethod===\`chatgpt\`\|\|…,o=i?.authMethod??null` |
| G2 | `if(n!==\`chatgpt\`&&n!==\`personalAccessToken\`&&n!==\`amazonBedrock\`)return null;` → `if(!1)return null;` |
| G3 | `return t?.type===\`chatgpt\`\|\|t?.type===\`amazonBedrock\`?u.serviceTier:null})()` → `return !0\|\|t?.type===…?u.serviceTier:null})()` |
| G4 | `return n.account?.type===\`chatgpt\`\|\|n.account?.type===\`amazonBedrock\`})` → `return !0\|\|n.account?.type===…})` |

The exact strings are in [patch-codex-speed.mjs](patch-codex-speed.mjs) (`PATCHES`). The copilot check in G4 is kept.
Nothing in `app-primary` or `app-shared` needs to change.

## 4. Build, apply, update, revert (superseded by the project README; kept for the record)

Everything is driven from this folder, `C:\Users\wjw\Desktop\codex-speed-patch\`. Double-click the `.cmd` files
(each leaves its window open), or run the script directly:

| Entry point | What it does | Script call |
|---|---|---|
| `patch.cmd` | Build the patched copy of the installed version into `build\<version>\app` (~2 GB). Skips if already built and verified. Starts nothing. | `--full-copy --if-needed` |
| `launch.cmd` | Start the patched copy; builds it first if needed. Refuses while the Store app or another copy runs. | `--full-copy --if-needed --launch` |
| `update.cmd` | Ask the Microsoft Store for an update (winget, product `9PLM9XGG6VKS`), then build the new version if needed and start it, then print the status. | `--store-update --full-copy --if-needed --launch` |
| `status.cmd` | Installed version, builds and their verification state, what is running, which builds are stale. | `--status` |
| `cleanup.cmd` | Show the status, ask, then delete builds of other versions. Never deletes a running copy or the installed version's build. | `--prune` |
| `check-tier.cmd` | Tier of every turn in the last 3 hours from the engine's own log database. | `check-tier.mjs 3` |

**Dry run** (patched `app.asar` + `ChatGPT.exe` only, no 2 GB copy): `node patch-codex-speed.mjs`. Every build is verified
(header hash = resource hash; patched strings present, old ones absent; file-level integrity of the patched bundle;
47 sampled untouched files re-hash correctly) and the report goes to `build\<version>\report.json`.

**Apply = launch.cmd.** Quit the Store app completely first (tray icon too; both share the user-data directory `Codex`,
running both at once will fight over the profile lock). The copy runs from `build\<version>\app\ChatGPT.exe`.

**After an app update = update.cmd.** The Store updates the package in place (new folder
`OpenAI.Codex_<new version>_x64__…`), the script sees the new version, builds `build\<new version>\app` and starts it.
If the old patched copy is still running, the start is skipped with a message: quit it, run `launch.cmd`, then
`cleanup.cmd` to delete the old build. The Store also updates the package by itself in the background, so
`launch.cmd` alone covers that case too (it builds whatever version is installed). `update.cmd` only adds the explicit
"check now" through winget; if winget cannot reach the Store, use Microsoft Store > Library > Get updates and then `launch.cmd`.

Check that it works: the model picker in the composer should show the Speed submenu with Standard / Fast / Ultrafast; the
request must then carry `service_tier` to the gateway. Verify that on the gateway side (Sub2API request log on CT 121) or
with a local capturing proxy; the UI alone does not prove it.

**Revert:** delete `build\`. The Store installation is untouched. If the Store app itself ever misbehaves, repair or
reinstall it from the Microsoft Store (Settings → Apps → Codex → Advanced options → Repair / Reset, or reinstall).

## 7. Test result (2026-10-30, launched with the user's OK)

- The Store instance was closed first (its close handler left 12 background processes, stopped by hand). The copy started
  from `build\app\ChatGPT.exe` at 16:06:36 with no SmartScreen block; main window, 13 helper processes and the engine
  (`build\app\resources\codex.exe`) came up. Log warnings only about the missing package identity
  (`windows-updater`: "The process has no package identity", so the self-updater is inert) and remote control wanting a
  ChatGPT sign-in. Unpackaged, the app uses a fresh Electron profile in `%APPDATA%\Codex` and logs in
  `%LOCALAPPDATA%\Codex\Logs`; the Store app's profile lives in `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\Codex`.
  Both share `~/.codex` (config, auth, sessions).
- The Speed submenu appeared in the composer (user-confirmed) and three turns were sent: 16:08 (default), 16:10 and 16:12
  with Fast / Ultrafast chosen.
- **Engine side** (`~/.codex/logs_2.sqlite`, table `logs`, span field `service_tier` of each `session_task.turn`):
  every turn of the **unpatched** Store app this afternoon carried `service_tier=default` although `config.toml` says
  `service_tier = "fast"`; the **patched** copy's turns carried `priority` (16:08:31, the config default), `ultrafast`
  (16:10:19) and `ultrafast` (16:12:42).
- **Wire** (passive `tcpdump` on BU01's `vmbr1`, Caddy → CT 121 plain HTTP, fields grepped per packet without stream
  attribution): `"service_tier":"ultrafast"` appeared exactly twice, both next to `gpt-6-astra`, matching the two ultrafast
  turns; all other `service_tier` values in the window sat next to other models (other users). A second, attributable
  capture was lost to a parsing slip (tcpdump ran without `-n`, so the port appeared as `http-alt`) and was deleted
  unparsed; redo it with `tcpdump -n` if wire-level attribution is ever needed. Capture files were removed from the host.
- **Gateway** (`usage_logs.service_tier` for key `office_key`): all three logged as `priority`, because group 9
  `Fysics PERD | OpenAI` has `force_openai_fast` on since 15:09 (see the infra repo, CT 121 step 9b). So through this group
  the gateway overrides the client's choice; Ultrafast cannot be exercised upstream until the force is off or the key moves
  to a group without it. Note also that gateway billing is already the 2× priority rate for every request.

## 8. Proposal: letting Ultrafast reach OpenAI (not done; needs the user's OK, it is a gateway change)

Facts (read 2026-10-30, CT 121 database, read-only):

- All five of the user's keys (`office_key` 3, 25, 27, `office_wsl_key` 35, `office_magpie_key` 52) are in group 9
  `Fysics PERD | OpenAI`, which forces `priority` on every request. The user also holds active subscriptions on group 10
  `Fysics PERD Intern | OpenAI` (ids 7, 1, 19), which has **no** force.
- Groups 9 and 10 are otherwise alike: rate multiplier 1.0, no USD limits, no model routing, both exclusive. Group 10 caps
  reasoning effort at `xhigh` (the config uses `high`, so no effect) and uses different OpenAI OAuth accounts
  (JUPITER.O, EARTH.G, MARS.G, VENUS.O, shared with the interns) instead of group 9's MERCURY.O, URANUS.O, SATURN.O, PLUTO.O, MERCURY.G.
- `api_keys` has the trigger `trg_api_keys_auth_cache_invalidation`, so changing a key's group in the database takes effect
  within seconds (unlike the `force_openai_fast` column on `groups`, which the groups trigger ignores).
- Ultrafast was already accepted upstream twice today before the force was switched on (key 3 at 14:54:29 on PLUTO.O and
  14:54:57 on MERCURY.G): no error, but 126–127 output tokens in 14.0 s / 10.5 s with first token after 2.1 s / 5.2 s,
  i.e. **about 10 tokens/s, not faster than priority's ~19 tokens/s**. Expect "accepted" rather than "faster" until OpenAI
  enables the tier for these accounts.

Options:

| | Change | Effort / risk | Rollback |
|---|---|---|---|
| **A (recommended)** | Move `office_key` (id 3) to group 10 for the test: admin UI → API keys → edit → group, or `UPDATE api_keys SET group_id = 10, updated_at = now() WHERE id = 3;` (trigger invalidates the cache) | 2 minutes; only this PC's key changes; requests are billed to the user's group-10 subscription and use the intern pool's accounts | same statement with `group_id = 9` |
| B | Fix the fork: `force_openai_fast` should upgrade an absent/standard tier only and leave an explicit `ultrafast` untouched; release `0.2.19-fysics.3` through `deploy/fysics/RELEASING.md` | ~1–2 h build + deploy, snapshot first; benefits every group | previous binary (`/opt/sub2api/sub2api.prev`) |
| C | Switch the force off on group 9 during the test | touches 29 keys / 18 subscriptions of the trial | re-enable |

Measuring after A: send the same prompt three times from the patched app (Standard, Fast, Ultrafast) and compare
`usage_logs.service_tier`, `output_tokens`, `duration_ms`, `first_token_ms` for key 3 (tokens/s = output_tokens ÷ (duration − first token)).
Move the key back to group 9 afterwards so the daily usage stays on the PERD subscription.

**Done 2026-10-30 16:52 (option A, with the user's OK)** and tested 16:58–17:02 in the existing thread (~30k cached context,
`gpt-6-astra`, reasoning `high`), one gateway row per request:

| Tier chosen in the app | `usage_logs.service_tier` | account | first token | duration | output tokens | tokens/s after first token |
|---|---|---|---|---|---|---|
| Standard (6 requests) | empty | VENUS.O | 6.7–7.7 s | 15–23 s | 310–514 | 25–41 |
| Fast | `priority` | VENUS.O | 7.2 s | 13.6 s | 265 | 41 |
| Ultrafast | `ultrafast` | MARS.G | 7.4 s | 21.9 s | 392 | 27 |
| Ultrafast | `ultrafast` | VENUS.O | 7.6 s | 15.1 s | 298 | 40 |

Engine log for the same turns: `default`, `default`, `default`, `priority`, `ultrafast`, `ultrafast`. So with the force out
of the way the gateway passes the client's tier through unchanged, OpenAI accepts `ultrafast` on these subscription
accounts without error, and **no tier is measurably faster**: 25–41 tokens/s and ~7 s to first token on all three
(the first-token time is reasoning on the 30k context, not the tier). Side observation: group 10's accounts streamed at
25–41 tokens/s on the standard tier, against the 10–20 measured on group 9's accounts earlier in the day (CT 121 step 9b);
per-account pace differs more than the tier does.

## 9. Does fast mode make a difference? (gateway usage log, 2026-10-28 → 10-30, read-only)

Method: every streamed `gpt-6*` request with ≥ 100 output tokens; speed = output tokens ÷ (duration − first token).
`output_tokens` includes reasoning tokens, so these are higher than the "visible characters per second" measured by eye,
but comparisons between tiers are fair.

| Model | Tier | Requests | Median tokens/s (p25–p75) | Median first token |
|---|---|---|---|---|
| gpt-6-astra | standard | 26 329 | 52.7 (38.5–75.4) | 8.3 s |
| gpt-6-astra | priority | 4 200 | 81.7 (59.4–114.7) | 7.8 s |
| gpt-6.1-sol | standard | 8 809 | 76.9 (45.2–109.1) | 7.0 s |
| gpt-6.1-sol | priority | 2 472 | 107.4 (71.4–161.8) | 9.3 s |
| gpt-6-astra | ultrafast | 4 | 25.5 | 6.3 s |

Group 9 as a natural experiment (same users and accounts, switch at 15:09 today): gpt-6-astra 54.2 → 75.2 tokens/s
(2 159 → 1 043 requests, +39 %), gpt-6.1-sol 71.8 → 101.3 (+41 %). Group 10 (never forced) today: astra standard 60.9
(3 760) vs priority 62.0 (128), i.e. no gain there. Per account (astra, 3 days, standard → priority): VENUS.O 44.7 → 90.7,
PLUTO.O 45.9 → 82.5, MERCURY.G 50.2 → 87.7, URANUS.O 43.5 → 71.6, SATURN.O 47.8 → 69.0, MERCURY.O 33.0 → 45.1,
MARS.G 52.5 → 65.1, JUPITER.O 64.2 → 71.2, EARTH.G 52.9 → 49.2. Time of day matters too: astra standard ran 56–87 tokens/s
in the morning and 39–45 between 15:00 and 17:00 (our tests fell in that window).

Conclusion: fast mode (`priority`) raises output throughput by roughly 1.4–1.6× on the median, confirmed by group 9's own
before/after, but the gain ranges from none (EARTH.G, JUPITER.O) to 2× (VENUS.O) depending on the account, it does not
shorten the time to first token (reasoning), and it costs 2× quota. Ultrafast shows no gain at all in the few requests
that exist. For the trial review: switching the slowest accounts out of the pool may be worth as much as the tier.

## 10. Re-applying after an app update (2026-10-30 evening rewrite of the script)

What breaks on an update: the package folder name (version), the minified identifier names and bundle file hashes, and
the asar header hash in the launcher. The rewritten `patch-codex-speed.mjs` handles all three:

- it finds the installed package with `Get-AppxPackage -Name OpenAI.Codex` (fallback: newest `OpenAI.Codex_*` folder);
- it matches the four gates by their stable literals (`chatgpt`, `personalAccessToken`, `amazonBedrock`, `.serviceTier`,
  `return null`) with the minified identifiers as back-referenced wildcards, across every `webview/assets/*.js` and
  `.vite/build/*.js` bundle. Each gate must match **exactly once**; otherwise the build aborts and names the gate and the
  match count, which is the signal that OpenAI changed that code and the pattern needs re-deriving (section 2 shows how);
- it recomputes the integrity resource from the new header, as before;
- it builds into `build\<installed version>\app`, so an update produces a new folder beside the old one.

The regex build was checked against the exact-string build of this version: identical asar (header hash `19904305…`).

**Daily use:** run `launch.cmd` (or a shortcut to it). It quits nothing by itself: if the Store app is running it
says so and stops. Otherwise it builds the current version if not yet built (`--full-copy --if-needed`, ~2 GB, a few
minutes) and starts `build\<version>\app\ChatGPT.exe`. `update.cmd` does the same after first asking the Store for an
update; `cleanup.cmd` deletes builds of old versions (and the unversioned `build\app` from 2026-10-30 once the versioned
build of the same version exists), never a running one. Section 4 has the full table.

**Checking that the tier is really sent** after an update: send a message with Fast or Ultrafast chosen, then

```bash
node C:\Users\wjw\Desktop\codex-speed-patch\check-tier.mjs
```

prints the tier of each recent turn from the engine's own log database (`~/.codex/logs_2.sqlite`), independent of any gateway.

**When the build aborts with "gates could not be matched":** OpenAI changed the code around the gate. Extract the bundle
(section 2's method: asar header → file bytes), search for the literals (`personalAccessToken`, `amazonBedrock`,
`serviceTier`), read the surrounding function, and adjust that gate's regex in `GATES`. If the gate disappeared
because the upstream app now supports speed tiers for custom providers, the patch is no longer needed.

The only durable fix is upstream: an issue or pull request on github.com/openai/codex asking that service-tier access be
derived from `configRequirements/read` and `model/list` instead of the auth method. Until then this stays a rebuild per update.

## 5. Verified / not verified

Verified on this PC:

- fuse wire, integrity resource location and that its value equals `sha256(asar header JSON)` of the installed asar;
- package folder read-only, files copyable;
- the four gate sites and their callers in the installed bundle (the names above are from this exact build);
- the dry-run output: replacements applied once each, new header hash written into the launcher copy, integrity entries
  for the patched file recomputed, sampled untouched files intact.

Verified by the launch (section 7): the app runs outside its MSIX package, the runtime accepts the rebuilt asar, the
Speed submenu shows, and the chosen tier reaches the engine and the wire.

Not verified:

- Ultrafast upstream: the gateway group forces `priority`, so no request has reached OpenAI with `ultrafast` yet;
- long-term side effects of running without package identity (notifications, protocol/file associations, the inert updater);
- anything after the next app update: the replacement strings and the integrity hash are specific to 26.1027.3384.0.

## 6. Files

- `patch-codex-speed.mjs` — locates the installed app, asar reader/writer, regex gate patcher, launcher-resource rewrite,
  verification, Store update via winget, status, prune, optional launch. No npm packages.
- `patch.cmd`, `launch.cmd`, `update.cmd`, `status.cmd`, `cleanup.cmd`, `check-tier.cmd` — the entry points (table in section 4).
- `AGENTS.md` (+ `CLAUDE.md` including it) — operating manual for LLM agents: rules, entry points, failure handling, how to verify.
- `check-tier.mjs` — prints the service tier of recent turns from the engine's log database.
- `build\<version>\app\` — one full patched copy per app version, `build\<version>\report.json` its build/verification report.
  `build\app\` is the first, unversioned build from 2026-10-30 (same version 26.1027.3384.0); `cleanup.cmd` removes it.
- Config excerpt used (secret redacted):

```toml
model_provider = "OpenAI"
model = "gpt-6-astra"
service_tier = "fast"
model_catalog_json = "C:/Users/wjw/.codex/models-speed-options.json"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "http://172.16.50.88:8091"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "<redacted>"

[features]
ultrafast_mode = true
fast_mode = true
```

Backups of the earlier config/catalog changes: `C:\Users\wjw\.codex\backups\speed-settings-2026-10-30T07-18-41-033Z\`.
