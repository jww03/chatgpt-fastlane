#!/bin/zsh -l
# macOS counterpart of cleanup.cmd. Delete builds of other versions (keeps the installed version's build and anything running).
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --status
echo
read -q "?Delete the old builds listed above? [y/N] " || { echo; exit 0; }
echo
node patch-codex-speed.mjs --prune
