#!/bin/zsh -l
# macOS counterpart of launch.cmd. Live mode: start the official ChatGPT patched in memory (no build, no copy).
# If it already runs that way it comes to the front; if ChatGPT runs normally, a message says so (quit it first).
# Everything printed is also in build/launch.log.
cd "${0:A:h}" || exit 1
command -v node >/dev/null || source ~/.zshrc >/dev/null 2>&1   # node from nvm only
node patch-codex-speed.mjs --full-copy --if-needed --launch --gui
[ $? -ne 0 ] && echo && echo "Build or launch failed. See the messages above, build/launch.log and README.md."
