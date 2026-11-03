#!/bin/zsh -l
# macOS counterpart of cleanup.cmd. Delete the patched copies Fastlane V0 left in build/ (keeps anything running).
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --status
echo
read -q "?Delete the leftover copies listed above? [y/N] " || { echo; exit 0; }
echo
node patch-codex-speed.mjs --cleanup
