#!/bin/zsh -l
# macOS counterpart of update.cmd. macOS has no Store to ask: prints how ChatGPT updates itself, then builds the
# installed version if needed, starts it and prints the status.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --store-update --full-copy --if-needed --launch
echo
node patch-codex-speed.mjs --status
