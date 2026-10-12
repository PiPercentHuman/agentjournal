#!/usr/bin/env bash
# The correction test: 10 worlds, three arms on each, the change one message back (recent) and two (late).
# usage: PI_DIR=<folder with pi in node_modules> bash run_correction.sh <first seed> <last seed>
set -u
cd "$(dirname "$0")"
mkdir -p correction-runs
for v in "" "--late"; do
  for s in $(seq "$1" "$2"); do
    for a in keep 0.2.1 0.2.2; do
      python correction_test.py "$a" "$s" $v > "correction-runs/log-$a-s$s${v:+-late}.txt" 2>&1 < /dev/null
      echo "done ${v:-recent} $a s$s"
    done
  done
done
echo "done seeds $1-$2"
