#!/bin/bash
cd "$(dirname "$0")"
TAG="$1"
mkdir -p "work-$TAG"
cd "work-$TAG"
claude -p "$(cat ../prompts/$TAG.txt)" --model opus --dangerously-skip-permissions --output-format text < /dev/null > "../logs/$TAG.log" 2>&1
echo "exit $? $(date)" >> "../logs/$TAG.log"
