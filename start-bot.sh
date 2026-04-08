#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin"
cd /Volumes/Core/claude-discord-bot
unset CLAUDECODE
exec /usr/local/bin/node /Volumes/Core/claude-discord-bot/bot.js
