"""Pilot: does a rule given once survive a full context? One seeded world, two ways of handling the overflow.

usage: python pilot.py <compaction|clm|control> <seed> [--files 24] [--window 12000] [--card] [--model qwen38]

anchor = our anchor-memory extension (pi compaction off).
control = plain pi with a window big enough (30000) that nothing is ever cut: what the model does with no overflow.

The world: N note files, each ~700 tokens of filler with one "KEY: <word>" line. A few are marked URGENT.
The task: read them in order, one at a time, and append "<file> <key>" to answers.txt.
Two rules are given ONCE, in the first message:
  R-urgent  the key of an URGENT file is written in UPPERCASE      (applies early and late: a within-trial control)
  R-end     after the last file, append exactly "END 7Q-PELICAN"   (applies only after the context has overflowed)
Scored by plain code from answers.txt; the pi JSON stream and session file are kept beside it.
"""
import json, os, random, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PI = os.path.join(HERE, "..", "pi")
CLI = os.path.join(PI, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
EXT = os.path.join(PI, "node_modules", "@lolipopshock", "pi-clm")
ANCHOR = os.path.join(PI, "extensions", "anchor-memory", "index.ts")

cond, seed = sys.argv[1], int(sys.argv[2])
assert cond in ("compaction", "clm", "control", "anchor", "dreamlog", "shipped")
# shipped = the published pi extension (github/agentjournal/pi/extensions/agentjournal.ts) with pi compaction left ON,
# as a user would run it: the extension must cancel pi's compaction itself
SHIPPED = os.path.join(HERE, "..", "..", "github", "agentjournal", "pi", "extensions", "agentjournal.ts")
# dreamlog = (earlier working name of AgentJournal) pi's ordinary compaction + the paste-in block appended to the system prompt: the way it ships
# (instructions only, nothing enforced by code), loaded the way tools load AGENTS.md
DREAMLOG = os.path.join(HERE, "..", "..", "github", "agentjournal", "AGENTS-snippet.md")
N = int(sys.argv[sys.argv.index("--files") + 1]) if "--files" in sys.argv else 24
WINDOW = int(sys.argv[sys.argv.index("--window") + 1]) if "--window" in sys.argv else (30000 if cond == "control" else 16000)
MODEL = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else "qwen38"   # the server alias
# pi-ai caps a reply at window - estimate - 4096 tokens (floor 1), so pi compaction must trigger more than 4096
# below the window or the run ends on a 1-token "length" reply first (every overflow run of the 12K pilot did).
# Both conditions cut at the same place: compaction at window - 6144; pi-clm's guard at
# min(budget - reserve, window - 4096 - reserve) = window - 6144 with reserve 2048.
RESERVE, KEEP, CLM_RESERVE = 6144, 3000, 2048
END_LINE = "END 7Q-PELICAN"
# --card: the sampling the model's own card recommends for instruct use (temperature 0.7, top_p 0.8, top_k 20,
# presence penalty 1.5). Without it the server's defaults apply.
CARD = "--card" in sys.argv
# --v2: adds rule TOTAL <number of URGENT files>, a count that must be carried across the whole job.
V2 = "--v2" in sys.argv
# --amode tail|nudge|consolidate: who updates anchor-memory's NOW (see the extension header)
AMODE = sys.argv[sys.argv.index("--amode") + 1] if "--amode" in sys.argv else "tail"
SAMPLING = {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "presence_penalty": 1.5} if CARD else None

WORDS = ("the river keeps a record of every season that passes through the valley and nobody reads it because "
         "people prefer the weather report from the town where reports are short and maps are drawn by hand "
         "with careful ink while the old ferry crosses twice a day carrying bread tools letters and rumours "
         "about a bridge that the council has promised since before the mill was closed for the winter").split()
SYL = ["ba", "ko", "ri", "tu", "ne", "sa", "vi", "lo", "dra", "mek", "pon", "zel", "fir", "gan", "hul", "qua"]


def world(seed, n):
    r = random.Random(seed)
    urgent = {3, n // 2 + 3, n - 2}            # one before any overflow, two after
    files = []
    for i in range(1, n + 1):
        key = "".join(r.choice(SYL) for _ in range(3))
        lines = [" ".join(r.choice(WORDS) for _ in range(13)).capitalize() + "." for _ in range(40)]
        lines.insert(r.randrange(5, 35), f"KEY: {key}")
        if i in urgent:
            lines.insert(r.randrange(2, 38), "STATUS: URGENT")
        files.append({"name": f"n{i:02d}.txt", "key": key, "urgent": i in urgent, "text": "\n".join(lines) + "\n"})
    return files


def prompt(n):
    return (f"There are {n} files, notes/n01.txt to notes/n{n:02d}.txt, in the folder you are already in. Use those "
            "relative paths exactly; never use an absolute path and do not list the folder. Each file has exactly one "
            "line that starts with KEY:. Work through them in order, one file at a time. For each file: read it with "
            "the read tool (path notes/n01.txt and so on), "
            "then add one line to answers.txt with bash, like this: echo \"n01.txt thekey\" >> answers.txt . "
            "Do not read two files before writing, and do not write a script that does them all.\n\n"
            + ("Three rules for the whole job, which I will not repeat:\n"
               "1. If a file contains the line STATUS: URGENT, write its key in UPPERCASE.\n"
               "2. Keep count of how many files contain STATUS: URGENT. After the last file, add a line: TOTAL <that number>\n"
               f"3. Then add one final line to answers.txt that says exactly: {END_LINE}\n\n" if V2 else
               "Two rules for the whole job, which I will not repeat:\n"
               "1. If a file contains the line STATUS: URGENT, write its key in UPPERCASE.\n"
               f"2. After the last file, add one final line to answers.txt that says exactly: {END_LINE}\n\n")
            + "When that final line is written, reply with the single word FINISHED.")


def score(files, answers):
    lines = [l.strip() for l in answers.splitlines() if l.strip()]
    rows, by = [], {}
    for l in lines:
        parts = l.split()
        if len(parts) >= 2 and parts[0].lower().startswith("n") and parts[0].lower().endswith(".txt"):
            by.setdefault(parts[0].lower(), parts[1])
    for f in files:
        got = by.get(f["name"])
        rows.append({"file": f["name"], "urgent": f["urgent"], "written": got is not None,
                     "key_ok": bool(got) and got.lower() == f["key"],
                     "case_ok": bool(got) and (got == f["key"].upper() if f["urgent"] else got == f["key"])})
    return {"lines": len(lines), "files_written": sum(r["written"] for r in rows),
            "keys_ok": sum(r["key_ok"] for r in rows),
            "urgent": [{"file": r["file"], "written": r["written"], "upper": r["written"] and r["case_ok"]} for r in rows if r["urgent"]],
            "end_rule": bool(lines) and lines[-1] == END_LINE,
            "end_line_anywhere": END_LINE in lines, "last_line": lines[-1] if lines else None,
            # v2: a count carried across the whole job (the last step cannot show it)
            "total_ok": f"TOTAL {sum(f['urgent'] for f in files)}" in lines,
            "total_line": next((l for l in lines if l.upper().startswith("TOTAL")), None)}


run = os.path.join(HERE, "runs", (f"{MODEL}-" if MODEL != "qwen38" else "") + f"{cond}-s{seed}-w{WINDOW}" + ("-card" if CARD else "") + ("-v2" if V2 else "") + (f"-{AMODE}" if cond == "anchor" and AMODE != "tail" else "") + (f"-f{N}" if N != 24 else ""))
shutil.rmtree(run, ignore_errors=True)
work, agent, sess = (os.path.join(run, d) for d in ("work", "agent", "sessions"))
for d in (os.path.join(work, "notes"), agent, sess):
    os.makedirs(d)
files = world(seed, N)
for f in files:
    open(os.path.join(work, "notes", f["name"]), "w", newline="\n").write(f["text"])
json.dump({"providers": {"local": {"baseUrl": "http://127.0.0.1:8090/v1", "api": "openai-completions", "apiKey": "local",
           "models": [dict({"id": MODEL, "contextWindow": WINDOW, "maxTokens": 1024}, **({"samplingParams": SAMPLING} if SAMPLING else {}))]}}}, open(os.path.join(agent, "models.json"), "w"))
json.dump({"compaction": {"enabled": cond not in ("control", "anchor"), "reserveTokens": RESERVE, "keepRecentTokens": KEEP}}, open(os.path.join(agent, "settings.json"), "w"))

env = dict(os.environ, PI_CODING_AGENT_DIR=agent, PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0")
cmd = ["node", CLI, "--mode", "json", "-p", "--model", f"local/{MODEL}", "--thinking", "off", "--no-context-files",
       "--no-skills", "--no-prompt-templates", "-ne", "--session-dir", sess]
if cond == "clm":
    cmd += ["-e", EXT]
    # NATIVE_COMPACTION off: in "auto" Pi's own summary still ran on overflow recovery and reset the model's
    # projection (12K pilot), so the clm condition was partly a compaction run. Off = the model and the guard only.
    env.update(PI_CLM_RESERVE=str(CLM_RESERVE), PI_CLM_NATIVE_COMPACTION="off")
if cond == "anchor":
    env.update(ANCHOR_MODE=AMODE)
    cmd += ["-e", ANCHOR]   # anchor-memory: anchors + a NOW the model rewrites + the last 3 steps
if cond == "shipped":
    cmd += ["-e", SHIPPED]
if cond == "dreamlog":
    cmd += ["--append-system-prompt", DREAMLOG]
cmd.append(prompt(N))

t0 = time.time()
with open(os.path.join(run, "stream.jsonl"), "wb") as out, open(os.path.join(run, "stderr.log"), "wb") as err:
    try:
        rc = subprocess.run(cmd, cwd=work, env=env, stdout=out, stderr=err, timeout=25 * 60).returncode
    except subprocess.TimeoutExpired:
        rc = "timeout"
secs = round(time.time() - t0)

ev, usage, last_text = {}, [], ""
for line in open(os.path.join(run, "stream.jsonl"), encoding="utf-8", errors="replace").read().split("\n"):
    if not line.strip():
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    ev[e.get("type")] = ev.get(e.get("type"), 0) + 1
    if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
        u = e["message"].get("usage") or {}
        usage.append({"in": u.get("input", 0), "cached": u.get("cacheRead", 0), "out": u.get("output", 0)})
        last_text = " ".join(c.get("text", "") for c in e["message"].get("content", []) if isinstance(c, dict) and c.get("type") == "text")
entries = {}
for fn in os.listdir(sess):
    for line in open(os.path.join(sess, fn), encoding="utf-8", errors="replace"):
        try:
            t = json.loads(line).get("type")
            entries[t] = entries.get(t, 0) + 1
        except Exception:
            pass
ans_path = os.path.join(work, "answers.txt")
answers = open(ans_path, encoding="utf-8", errors="replace").read() if os.path.exists(ans_path) else ""
rec = {"release": "agentjournal-0.1.1" if cond == "shipped" else None, "amode": AMODE if cond == "anchor" else None, "task": "v2-total" if V2 else "v1", "model": MODEL, "cond": cond, "seed": seed, "sampling": "card" if CARD else "server-default", "files": N, "window": WINDOW, "exit": rc, "secs": secs,
       "assistant_turns": len(usage), "peak_request": max((u["in"] + u["cached"] for u in usage), default=0),
       "tokens_processed": sum(u["in"] for u in usage), "tokens_cached": sum(u["cached"] for u in usage),
       "tokens_out": sum(u["out"] for u in usage), "session_entries": entries,
       "said_finished": "FINISHED" in last_text.upper(), "score": score(files, answers)}
open(os.path.join(HERE, "results.jsonl"), "a").write(json.dumps(rec) + "\n")
print(json.dumps(rec, indent=1))
