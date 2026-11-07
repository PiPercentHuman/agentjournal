"""One trial: one contender, one seeded world, one headless Claude Code run. Appends one record.

  python trial.py <contender> <seed> [--files 60] [--lines 40] [--model haiku] [--out runs/x.jsonl] [--keep-work]

Contenders (the meter mod is loaded beside every one of them and changes nothing):
  shipped      Claude Code as it ships: its own compaction
  plain-cut    a mod answers compaction with the first message and the last few steps
  journal      AgentJournal as a mod: pins, one line per action, the last steps
  keep         nothing is ever cut: the trigger is left where Claude Code puts it
  hooks        shipped, plus AgentJournal 0.2.1 as settings hooks: Claude Code still writes its own summary, and
               the pins and the journal are read back in after it

Compaction is made to run early for every contender that compacts (COMPACT_AT below), so that a job of a few
dozen files overflows it more than once. That is our setting, not Claude Code's default.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from world import prompt, score, world

HERE = Path(__file__).resolve().parent
SCRATCH = Path(os.environ.get("AJ_SCRATCH", HERE.parents[1] / "experiment" / "runs"))
CLAUDE = os.environ.get("AJ_CLAUDE") or shutil.which("claude") or "claude"
MODS = HERE / "mods"
CONTENDERS = {"shipped": [], "hooks": [], "plain-cut": ["plain-cut"], "journal": ["agentjournal"], "keep": []}
WINDOW = 100_000          # the smallest auto-compact window Claude Code accepts
COMPACT_PCT = int(os.environ.get("AJ_COMPACT_PCT", "40"))   # compact at this share of it


def arg(name, default):
    return type(default)(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def run(contender, seed, n, lines, model, keep_work=False, timeout=45 * 60):
    tag = f"{contender}-{model}-f{n}-l{lines}-s{seed}"
    root = SCRATCH / tag
    shutil.rmtree(root, ignore_errors=True)
    work = root / "work"
    (work / "notes").mkdir(parents=True)
    files = world(seed, n, lines)
    for f in files:
        (work / "notes" / f["name"]).write_text(f["text"], "utf8", newline="\n")

    if contender == "hooks":
        (work / ".claude" / "hooks").mkdir(parents=True)
        for f in ("agentjournal-hook.mjs", "agentjournal.mjs"):
            shutil.copy(HERE / "hooks-0.2.1" / f, work / ".claude" / "hooks" / f)
        shutil.copy(HERE / "hooks-0.2.1" / "settings.json", work / ".claude" / "settings.json")

    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("CLAUDE", "ANTHROPIC"))}
    if "CLAUDE_CONFIG_DIR" in os.environ:
        env["CLAUDE_CONFIG_DIR"] = os.environ["CLAUDE_CONFIG_DIR"]
    if contender != "keep":
        env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(WINDOW)
        env["CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE"] = str(COMPACT_PCT)
    cmd = [CLAUDE, "-p", prompt(n), "--model", model, "--output-format", "stream-json", "--verbose",
           "--permission-mode", "dontAsk", "--allowedTools", "Read", "Bash",
           "--disallowedTools", "Agent", "Task", "WebSearch", "WebFetch", "Write", "Edit", "Glob", "Grep",
           "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence",
           "--plugin-dir", str(MODS / "meter")]
    for m in CONTENDERS[contender]:
        cmd += ["--plugin-dir", str(MODS / m)]

    t0 = time.time()
    with open(root / "stream.jsonl", "wb") as out, open(root / "stderr.log", "wb") as err:
        try:
            rc = subprocess.run(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            rc = "timeout"
    secs = round(time.time() - t0)
    return collect(contender, seed, n, lines, model, rc, secs, keep_work)


def collect(contender, seed, n, lines, model, rc, secs, keep_work=False):
    """Read what a finished trial left on disk and make its record. Calls nothing."""
    tag = f"{contender}-{model}-f{n}-l{lines}-s{seed}"
    root = SCRATCH / tag
    work = root / "work"
    files = world(seed, n, lines)

    result, api_error, bash = None, None, []
    for line in (root / "stream.jsonl").read_text("utf8", errors="replace").splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "result":
            result = e
        if e.get("type") == "assistant" and e.get("error"):
            api_error = e.get("error")
        if e.get("type") == "assistant":
            bash += [c["input"].get("command", "") for c in e["message"].get("content", [])
                     if c.get("type") == "tool_use" and c.get("name") == "Bash"]
    meter = work / ".meter" / "log.jsonl"
    # the meter's last row can be cut off when the process exits mid-write: it then reads as NUL bytes
    raw = meter.read_text("utf8", errors="replace").splitlines() if meter.exists() else []
    log = [json.loads(l) for l in raw if l.strip("\x00").strip()]
    meter_cut = any(l and not l.strip("\x00").strip() for l in raw)
    steps = [r for r in log if r["kind"] == "step" and r.get("usage")]
    folds = [r for r in log if r["kind"] == "compact"]
    ans = work / "answers.txt"
    answers = ans.read_text("utf8", errors="replace") if ans.exists() else ""

    def tok(key):
        return sum(s["usage"].get(key, 0) or 0 for s in steps)

    rec = {
        "contender": contender, "seed": seed, "files": n, "lines": lines, "model": model,
        "compact_at": None if contender == "keep" else WINDOW * COMPACT_PCT // 100,
        "exit": rc, "secs": secs or round(((result or {}).get("duration_ms") or 0) / 1000), "meter_cut": meter_cut,
        # a failed call is not a result: a trial with an API error is marked and never counted
        "valid": rc == 0 and result is not None and not result.get("is_error") and api_error is None and bool(steps),
        "api_error": api_error, "result_subtype": (result or {}).get("subtype"),
        "said_finished": "FINISHED" in str((result or {}).get("result", "")).upper(),
        "requests": len(steps),
        "fresh_in": tok("input_tokens"), "cache_write": tok("cache_creation_input_tokens"),
        "cache_read": tok("cache_read_input_tokens"), "out": tok("output_tokens"),
        "peak_request": max((sum(s["usage"].get(k, 0) or 0 for k in
                                 ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
                             for s in steps), default=0),
        "folds": [{"trigger": f["trigger"], "before": f["before"], "after": f.get("after"), "skip": f.get("skip"),
                   "tokensBefore": f.get("tokensBefore"), "tokensAfter": f.get("tokensAfter"),
                   "summary_out": (f.get("usage") or {}).get("output_tokens")} for f in folds],
        "cost_usd": (result or {}).get("total_cost_usd"),
        "limits": {x["kind"]: x["percentUsed"] for x in
                   (next((r for r in reversed(log) if r["kind"] == "measure"), {}).get("rateLimits") or [])},
        "context_end": (next((r for r in reversed(log) if r["kind"] == "measure"), {}).get("context") or {}).get("tokens"),
"bash": bash,
        "score": score(files, answers),
        "answers": answers,
    }
    # the per-trial files the footage is drawn from are kept beside the record
    keep = HERE / "runs" / "trials" / tag
    keep.mkdir(parents=True, exist_ok=True)
    if meter.exists():
        shutil.copy(meter, keep / "meter.jsonl")
    if (work / ".agentjournal").exists():
        shutil.copytree(work / ".agentjournal", keep / "agentjournal", dirs_exist_ok=True)
    if not keep_work:
        shutil.rmtree(work / "notes", ignore_errors=True)
    return rec


if __name__ == "__main__":
    contender, seed = sys.argv[1], int(sys.argv[2])
    assert contender in CONTENDERS, contender
    n, lines, model = arg("--files", 60), arg("--lines", 40), arg("--model", "haiku")
    if "--collect" in sys.argv:       # make the record of a trial that already ran, from its folder
        rec = collect(contender, seed, n, lines, model, arg("--exit", 0), arg("--secs", 0), True)
    else:
        rec = run(contender, seed, n, lines, model, "--keep-work" in sys.argv)
    out = Path(arg("--out", str(HERE / "runs" / f"{contender}.jsonl")))
    out.parent.mkdir(exist_ok=True)
    with open(out, "a", encoding="utf8") as f:
        f.write(json.dumps(rec) + "\n")
    show = {k: v for k, v in rec.items() if k != "answers"}
    print(json.dumps(show, indent=1))
