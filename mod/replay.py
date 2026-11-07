"""Score every recorded job again from what it left behind, and check the result is the one on record.

  python replay.py         exits 1 on the first job that does not reproduce

A record holds the job's seed and the answers file the agent wrote. The world is rebuilt from the seed, the
answers are scored again by plain code (world.py), and every token figure is added up again from the meter's log
of that job (runs/trials/<tag>/meter.jsonl). No model, no key and no Claude Code are needed.
"""
import json
import sys
from pathlib import Path

from world import score, world

HERE = Path(__file__).resolve().parent
KEYS = {"fresh_in": "input_tokens", "cache_write": "cache_creation_input_tokens",
        "cache_read": "cache_read_input_tokens", "out": "output_tokens"}
total = 0
for path in sorted((HERE / "runs").glob("*.jsonl")):
    rows = [json.loads(l) for l in path.read_text("utf8").splitlines() if l.strip()]
    for r in rows:
        tag = f"{r['contender']}-{r['model']}-f{r['files']}-l{r['lines']}-s{r['seed']}"
        again = score(world(r["seed"], r["files"], r["lines"]), r["answers"])
        if again != r["score"]:
            sys.exit(f"{tag}: the answers score {again}, the record says {r['score']}")
        meter = HERE / "runs" / "trials" / tag / "meter.jsonl"
        if meter.exists():
            log = [json.loads(l) for l in meter.read_text("utf8", errors="replace").splitlines() if l.strip("\x00").strip()]
            steps = [x for x in log if x["kind"] == "step" and x.get("usage")]
            if len(steps) != r["requests"]:
                sys.exit(f"{tag}: {len(steps)} requests in the meter log, {r['requests']} on record")
            for mine, theirs in KEYS.items():
                got = sum(s["usage"].get(theirs, 0) or 0 for s in steps)
                if got != r[mine]:
                    sys.exit(f"{tag}: {mine} adds up to {got}, the record says {r[mine]}")
            folds = [x for x in log if x["kind"] == "compact"]
            if len(folds) != len(r["folds"]):
                sys.exit(f"{tag}: {len(folds)} folds in the meter log, {len(r['folds'])} on record")
    total += len(rows)
    print(f"{path.stem:10s} {len(rows)} jobs  OK")
print(f"{total} of {total} jobs scored again to the same result")
