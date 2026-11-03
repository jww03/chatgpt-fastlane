#!/bin/zsh -l
# macOS counterpart of shortcut.cmd. Create or refresh ~/Applications/ChatGPT Fastlane.app, a small launcher that runs
# launch with this Node. Drag it to the Dock once.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --shortcut
