"""Run a grid of trials, a few at a time, and stop if the plan's limits climb.

  python run.py --contenders shipped,journal --seeds 1-3 [--files 60] [--lines 120] [--model haiku] [--jobs 3]

A trial already recorded as valid for the same contender, seed, job and model is not run again.
"""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from trial import CONTENDERS, HERE, arg, run

contenders = arg("--contenders", "shipped,journal").split(",")
a, _, b = arg("--seeds", "1-3").partition("-")
seeds = list(range(int(a), int(b or a) + 1))
n, lines, model, jobs = arg("--files", 60), arg("--lines", 120), arg("--model", "haiku"), arg("--jobs", 3)
WEEK_STOP = arg("--week-stop", 52)      # stop when the seven-day limit reads this or more
FIVE_STOP = arg("--five-stop", 75)
lock, stop = threading.Lock(), threading.Event()


def done(c, s):
    p = HERE / "runs" / f"{c}.jsonl"
    if not p.exists():
        return False
    return any(r["valid"] and (r["seed"], r["files"], r["lines"], r["model"]) == (s, n, lines, model)
               for r in map(json.loads, p.read_text("utf8").splitlines()))


def one(job):
    c, s = job
    if stop.is_set() or done(c, s):
        return
    try:
        rec = run(c, s, n, lines, model)
    except Exception as err:          # one broken trial must not end the grid; it is reported, never counted
        print(f"CRASH {c} s{s}: {type(err).__name__}: {err}", flush=True)
        return
    with lock:
        with open(HERE / "runs" / f"{c}.jsonl", "a", encoding="utf8") as f:
            f.write(json.dumps(rec) + "\n")
        sc, lim = rec["score"], rec.get("limits", {})
        print(f"{c:10s} s{s:<3d} valid={rec['valid']!s:5s} perfect={sc['perfect']!s:5s} files={sc['files_written']}/{sc['files']} "
              f"total={sc['total_line']} folds={len(rec['folds'])} req={rec['requests']} ${rec['cost_usd']} {rec['secs']}s limits={lim}",
              flush=True)
        if lim.get("seven_day", 0) >= WEEK_STOP or lim.get("five_hour", 0) >= FIVE_STOP:
            print("STOP: plan limits", lim, flush=True)
            stop.set()
        if not rec["valid"]:
            print("INVALID:", rec.get("api_error"), rec.get("result_subtype"), rec["exit"], flush=True)


assert all(c in CONTENDERS for c in contenders), contenders
grid = [(c, s) for s in seeds for c in contenders]
with ThreadPoolExecutor(jobs) as pool:
    list(pool.map(one, grid))
print("done" if not stop.is_set() else "stopped early")
