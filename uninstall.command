#!/bin/zsh -l
# macOS counterpart of uninstall.cmd. Stop the Fastlane helper, delete ~/Applications/ChatGPT Fastlane.app and build/.
# /Applications/ChatGPT.app was never changed and keeps running; ~/.codex and this folder are kept (README "Uninstall").
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
echo "This stops the Fastlane helper and deletes:"
echo "  - ~/Applications/ChatGPT Fastlane.app (remove it from the Dock yourself if you put it there)"
echo "  - ${0:A:h}/build/ (logs and any patched copies left from V0)"
echo "ChatGPT keeps running; from its next start it is the normal app. ~/.codex and this folder are kept."
echo
read -q "?Continue? [y/N] " || { echo; exit 0; }
echo
node patch-codex-speed.mjs --uninstall
