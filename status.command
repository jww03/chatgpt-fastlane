#!/bin/zsh -l
# macOS counterpart of status.cmd. Installed version, the builds in build/ and what is running.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --status
