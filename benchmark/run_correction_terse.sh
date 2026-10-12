#!/usr/bin/env bash
# The correction test with a short change ("Use END 4T-HERON instead."), three topics: nothing cut, 0.2.2, 0.2.2 with
# pin 1 marked as changed by pin 2, 0.2.2 with the changed rule written out in full under pin 1 by the test, and 0.3.0,
# where the model writes that updated version itself. Then 0.3.0 on the same job with the change written in full.
# usage: PI_DIR=<folder with pi in node_modules> bash run_correction_terse.sh <first seed> <last seed>
set -u
cd "$(dirname "$0")"
mkdir -p correction-runs
for s in $(seq "$1" "$2"); do
  for a in keep 0.2.2 marked updated 0.3.0; do
    python correction_test.py "$a" "$s" --late --terse > "correction-runs/log-$a-s$s-late-terse.txt" 2>&1 < /dev/null
    echo "done late-terse $a s$s"
  done
done
for s in $(seq "$1" "$2"); do
  python correction_test.py 0.3.0 "$s" --late > "correction-runs/log-0.3.0-s$s-late.txt" 2>&1 < /dev/null
  echo "done late 0.3.0 s$s"
done
echo "done seeds $1-$2"
