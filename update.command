#!/bin/zsh -l
# macOS counterpart of update.cmd. macOS has no Store to ask: explains how ChatGPT updates itself, then starts it with
# the Speed controls and prints the status.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --store-update --launch
echo
node patch-codex-speed.mjs --status
