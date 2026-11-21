#!/bin/bash
# usage: launch.sh TAG  (prompt in prompts/TAG.txt)
cd "$(dirname "$0")"
TAG="$1"
mkdir -p "work-$TAG"
cd "work-$TAG"
nohup claude -p "$(cat ../prompts/$TAG.txt)" --model opus --dangerously-skip-permissions --output-format text < /dev/null > "../logs/$TAG.log" 2>&1 &
disown
echo "$TAG pid $!"
