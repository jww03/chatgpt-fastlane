#!/bin/zsh -l
# macOS counterpart of check-tier.cmd. Service tier of each turn in the last 3 hours (from ~/.codex/logs_2.sqlite).
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node check-tier.mjs 3
