#!/usr/bin/env bash
# The full run: every contender on the same worlds, v2 task (rules + a carried count), Qwen3.5-9B, card sampling.
# usage: bash run_full.sh <first seed> <last seed>      (seeds 1-3 were run in the pilot under identical settings)
set -u
cd "$(dirname "$0")"
for s in $(seq "$1" "$2"); do
  for c in control compaction clm; do
    timeout 1500 python pilot.py "$c" "$s" --card --v2 --model qwen35-9b > "run-full-$c-s$s.log" 2>&1
  done
  for m in plain journal boundaries anchored; do
    timeout 1500 python pilot.py anchor "$s" --card --v2 --amode "$m" --model qwen35-9b > "run-full-anchor-$m-s$s.log" 2>&1
  done
done
echo "done seeds $1-$2"
