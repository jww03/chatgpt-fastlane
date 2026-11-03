#!/bin/zsh -l
# macOS counterpart of uninstall.cmd. Quit the patched copy, delete ~/Applications/ChatGPT Fastlane.app and build/.
# /Applications/ChatGPT.app is untouched; ~/.codex, the shared profile and this folder are kept (README "Uninstall").
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
echo "This quits the patched ChatGPT copy and deletes:"
echo "  - ~/Applications/ChatGPT Fastlane.app (remove it from the Dock yourself if you put it there)"
echo "  - ${0:A:h}/build/ (all patched copies and logs)"
echo "It keeps ~/.codex, ~/Library/Application Support/Codex (shared with ChatGPT) and this folder."
echo
read -q "?Continue? [y/N] " || { echo; exit 0; }
echo
node patch-codex-speed.mjs --uninstall
