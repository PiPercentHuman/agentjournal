#!/usr/bin/env bash
# The long job: 60 files (~37K tokens of reading), longer than every window here. 3 worlds each.
set -u
cd "$(dirname "$0")"
for s in 1 2 3; do
  timeout 2400 python pilot.py anchor "$s" --card --v2 --files 60 --amode sleep --model qwen35-9b > "run-long-sleep-s$s.log" 2>&1
  timeout 2400 python pilot.py control "$s" --card --v2 --files 60 --model qwen35-9b > "run-long-control-s$s.log" 2>&1
  timeout 2400 python pilot.py compaction "$s" --card --v2 --files 60 --model qwen35-9b > "run-long-compaction-s$s.log" 2>&1
  timeout 2400 python pilot.py anchor "$s" --card --v2 --files 60 --amode journal --model qwen35-9b > "run-long-journal-s$s.log" 2>&1
done
echo "done long"
