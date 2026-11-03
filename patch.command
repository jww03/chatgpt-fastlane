#!/bin/zsh -l
# macOS counterpart of patch.cmd. Build the fallback patched copy into build/<version>/ChatGPT Fastlane.app
# (APFS clone, ~1 GB of new data); launch uses live mode on macOS and needs no build. Start it with --copy.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --full-copy --if-needed
