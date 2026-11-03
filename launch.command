#!/bin/zsh -l
# macOS counterpart of launch.cmd. Start /Applications/ChatGPT.app with the Speed controls (patched in memory; nothing
# is installed or copied). If it already runs that way it comes to the front; if ChatGPT runs normally, a message says
# so (quit it first). Everything printed is also in build/launch.log.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --launch --gui
[ $? -ne 0 ] && echo && echo "Launch failed. See the messages above, build/launch.log and README.md."
