#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
frames="$HOME/.claude/skills/animating/scripts/frames.mjs"
mkdir -p music
if [ ! -f music/Ouroboros.mp3 ]; then
  curl -fsSL -o music/Ouroboros.part.mp3 https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ouroboros.mp3
  mv music/Ouroboros.part.mp3 music/Ouroboros.mp3
fi
rm -f mix.m4a
node build.mjs
node "$frames" mix --page glimmervoid-boards-riff.html --sheet cues.json --out mix.wav
ffmpeg -loglevel error -y -i mix.wav -c:a aac -b:a 160k mix.m4a
node build.mjs
node "$frames" audio-check --page glimmervoid-boards-riff.html
node "$frames" render --page glimmervoid-boards-riff.html --audio mix.m4a --out glimmervoid-boards-riff.mp4
echo "Credit with the post: Music: \"Ouroboros\" Kevin MacLeod (incompetech.com), CC BY 4.0"
