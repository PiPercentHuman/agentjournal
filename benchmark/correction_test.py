# Does a changed instruction survive the sleep? Two topics of 8 files. The first message gives the rules, among them
# the exact final line. The second message, sent when topic 1 is finished, changes that line, has the model close
# topic 1 with `agentjournal sleep`, and starts topic 2. After the fold the change exists only as a pin, next to the
# pin it replaces. The final line the model writes at the very end says which of the two it followed.
#
# Arms (same worlds, same two messages; only the extension differs):
#   keep   no extension, pi's compaction off: nothing is cut, the change stays in the conversation
#   0.2.1  the extension before this change (pins listed, nothing said about two that disagree)
#   0.2.2  this repository's extension (pins oldest first, "the later one is what the user wants now")
# --late: three topics. The change still comes after topic 1, but the final line is due after topic 3, two sleeps
# later, and the message that asks for it (the third) does not repeat it: the model has to pick between pin 1 and
# pin 2 with a newer pin after both.
# --terse: the change is one short sentence that does not say what it replaces ("Use END 4T-HERON instead.").
# Arm `marked`: 0.2.2 with a mark on pin 1's heading, written here by code as soon as pin 2 exists:
# "### 1 (pin 2 changes part of this: the final line)". No command writes such a mark yet; this arm measures the most
# a correct one could help.
# Arm `updated`: 0.2.2 with the changed rule written out in full as a sub-chapter under the pin it changes, again by
# code as soon as pin 2 exists: "#### 1.1 updated by pin 2 ..." followed by rule 2 with the new final line. The
# user's words in pin 1 and pin 2 are untouched. This measures the most a correct updated version could help.
# Arm `0.3.0`: this repository's extension. Nothing is written for the model: with the second message it is asked
# whether the message changes an earlier pin, and it writes the updated version itself (`agentjournal update`).
# `updates` in the record is what it wrote; `update_right` says one of them is for pin 1 and holds the new line only.
# The arms 0.2.2, marked and updated run the extension as released in 0.2.2 (commit a063493).
# Needs llama-server on 127.0.0.1:8090 serving qwen35-9b, and PI_DIR = a folder with pi in node_modules.
# Usage: python correction_test.py <arm> <seed> [--late] [--terse]
import json, os, random, re, shutil, subprocess, sys, time

arm, seed = sys.argv[1], int(sys.argv[2])
assert arm in ("keep", "0.2.1", "0.2.2", "marked", "updated", "0.3.0")
LATE, TERSE = "--late" in sys.argv, "--terse" in sys.argv
VARIANT = ("late" if LATE else "recent") + ("-terse" if TERSE else "")
HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "..")
PI = os.environ.get("PI_DIR", ".")
CLI = os.path.join(PI, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
RUNS = os.path.join(HERE, "correction-runs")
OLD, NEW = "END 7Q-PELICAN", "END 4T-HERON"
SYL = ["ba", "ko", "ri", "tu", "ne", "sa", "vi", "lo", "dra", "mek", "pon", "zel", "fir", "gan", "hul", "qua"]
WORDS = "the river keeps a record of every season that passes through the valley and nobody reads it".split()

r = random.Random(seed)
files = []
for topic, urgent in (("a", {3, 6}), ("b", {4, 7}), ("c", {2, 5}))[: 3 if LATE else 2]:
    for i in range(1, 9):
        key = "".join(r.choice(SYL) for _ in range(3))
        lines = [" ".join(r.choice(WORDS) for _ in range(12)).capitalize() + "." for _ in range(30)]
        lines.insert(r.randrange(4, 26), f"KEY: {key}")
        if i in urgent:
            lines.insert(r.randrange(2, 28), "STATUS: URGENT")
        files.append({"name": f"{topic}{i:02d}.txt", "key": key, "urgent": i in urgent, "text": "\n".join(lines) + "\n"})

RULE2 = (f"2. At the very end of the job, after the last file of topic {3 if LATE else 2} and not before, add a final line to "
         "answers.txt that says exactly: ")
FIRST = (
    ("This job has three topics. Topic 1 is notes/a01.txt to notes/a08.txt. Topics 2 and 3 come later: do not start "
     "them until I say so. " if LATE else
     "This job has two topics. Topic 1 is notes/a01.txt to notes/a08.txt. Topic 2 comes later: do not start it until I "
     "say so. ") +
    "Use those relative paths exactly. Each file has one line that starts with KEY:. For each file, one at a "
    "time: read it with the read tool, then add one line to answers.txt with bash, like this: "
    "echo \"a01.txt thekey\" >> answers.txt . Do not read two files before writing, and do not write a script that "
    "does them all.\n\n"
    "Rules for the whole job, which I will not repeat:\n"
    "1. If a file contains the line STATUS: URGENT, write its key in UPPERCASE.\n"
    f"{RULE2}{OLD}\n\n"
    "Do topic 1 now. When a08.txt is written, reply with the single word READY and stop.")
SECOND = (
    (f"Use {NEW} instead.\n\n" if TERSE else f"One change to the rules: the final line must now say exactly: {NEW}\n\n") +
    "First close topic 1 by running this in bash: agentjournal sleep \"topic 1 done: a01-a08 written\" . "
    "Then do topic 2, notes/b01.txt to notes/b08.txt, the same way as topic 1. " +
    ("When b08.txt is written, reply with the single word READY and stop." if LATE else
     "After b08.txt add the final line, then reply with the single word FINISHED."))
THIRD = (
    "Close topic 2 by running this in bash: agentjournal sleep \"topic 2 done: b01-b08 written\" . "
    "Then do topic 3, notes/c01.txt to notes/c08.txt, the same way. After c08.txt add the final line, "
    "then reply with the single word FINISHED.")

run = os.path.join(RUNS, f"{VARIANT}-{arm}-s{seed}")
shutil.rmtree(run, ignore_errors=True)
work, agent, sess = (os.path.join(run, d) for d in ("work", "agent", "sessions"))
for d in (os.path.join(work, "notes"), agent, sess):
    os.makedirs(d)
for f in files:
    open(os.path.join(work, "notes", f["name"]), "w", newline="\n").write(f["text"])
json.dump({"providers": {"local": {"baseUrl": "http://127.0.0.1:8090/v1", "api": "openai-completions", "apiKey": "local",
           "models": [{"id": "qwen35-9b", "contextWindow": 32000, "maxTokens": 1024,
                       "samplingParams": {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "presence_penalty": 1.5}}]}}},
          open(os.path.join(agent, "models.json"), "w"))
json.dump({"compaction": {"enabled": arm != "keep", "reserveTokens": 6144, "keepRecentTokens": 3000}}, open(os.path.join(agent, "settings.json"), "w"))

# Every arm can run `agentjournal sleep`; without the extension it only writes a line nobody folds on.
jroot = os.path.join(work, ".agentjournal")
env = dict(os.environ, PI_CODING_AGENT_DIR=agent, PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0",
           AGENTJOURNAL_SLEEP_TOKENS="100000", AGENTJOURNAL_ROOT=jroot,
           PATH=os.path.join(PKG, "plugin", "bin") + os.pathsep + os.environ["PATH"])
for k in ("CLAUDE_PID", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID"):
    env.pop(k, None)
cmd = ["node", CLI, "--mode", "json", "-p", "--model", "local/qwen35-9b", "--thinking", "off", "--no-context-files",
       "--no-skills", "--no-prompt-templates", "-ne", "--session-dir", sess]
def released(tag):
    """The extension as it was in a release, taken from this repository's history."""
    file = os.path.join(RUNS, f"agentjournal-{tag}.ts")
    if not os.path.exists(file):
        commit = {"0.2.1": "e973d6b", "0.2.2": "a063493"}[tag]
        open(file, "wb").write(subprocess.run(["git", "-C", PKG, "show", f"{commit}:pi/extensions/agentjournal.ts"], capture_output=True, check=True).stdout)
    return file

if arm == "0.3.0":
    cmd += ["-e", os.path.join(PKG, "pi", "extensions", "agentjournal.ts")]
if arm in ("0.2.1", "0.2.2"):
    cmd += ["-e", released(arm)]
if arm == "marked":
    src = open(released("0.2.2"), encoding="utf8", newline="").read()
    at = 'fs.writeFileSync(path.join(dir, "PINNED.md")'
    assert src.count(at) == 1
    marked = os.path.join(RUNS, "agentjournal-marked.ts")
    open(marked, "w", encoding="utf8", newline="").write(src.replace(
        at, 'if (pinHeads.length >= 2) pinHeads[0] += " (pin 2 changes part of this: the final line)";\n\t\t\t' + at))
    cmd += ["-e", marked]
if arm == "updated":
    src = open(released("0.2.2"), encoding="utf8", newline="").read()
    decl, shown = "let pins: string[] = [];", "${pinHeads[i]}\\n${p}"
    assert src.count(decl) == 1 and src.count(shown) == 2  # the memory block and PINNED.md
    sub = "\n\n#### 1.1 updated by pin 2 (this is rule 2 as it stands now; it replaces rule 2 above)\n" + RULE2 + NEW
    src = src.replace(decl, decl + "\n\tconst UPDATED = " + json.dumps(sub) + ";\n\tconst shown = (p: string, i: number) => "
                      "(i === 0 && pins.length >= 2 ? p + UPDATED : p);")
    updated = os.path.join(RUNS, "agentjournal-updated.ts")
    open(updated, "w", encoding="utf8", newline="").write(src.replace(shown, "${pinHeads[i]}\\n${shown(p, i)}"))
    cmd += ["-e", updated]
cmd += [FIRST, SECOND] + ([THIRD] if LATE else [])  # pi sends each message when the turn before it has ended

t0 = time.time()
with open(os.path.join(run, "stream.jsonl"), "wb") as out, open(os.path.join(run, "stderr.log"), "wb") as err:
    try:
        # stdin closed: pi reads a piped stdin as part of the prompt and waits on an open one
        rc = subprocess.run(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=20 * 60).returncode
    except subprocess.TimeoutExpired:
        rc = "timeout"

answers = open(os.path.join(work, "answers.txt")).read() if os.path.exists(os.path.join(work, "answers.txt")) else ""
lines = [l.strip() for l in answers.splitlines() if l.strip()]
by = {}
for l in lines:
    p = l.split()
    if len(p) >= 2 and p[0].endswith(".txt"):
        by.setdefault(p[0], p[1])
right = lambda fs: sum(by.get(f["name"]) == (f["key"].upper() if f["urgent"] else f["key"]) for f in fs)
last_topic = "c" if LATE else "b"
first_last = next((i for i, l in enumerate(lines) if l.startswith(last_topic)), len(lines))
last = lines[-1] if lines else None
journal = ""
for d in sorted(os.listdir(jroot)) if os.path.isdir(jroot) else []:
    p = os.path.join(jroot, d, "JOURNAL.md")
    if os.path.exists(p):
        journal += open(p, encoding="utf8").read()
jl = journal.splitlines()
inbox_file = os.path.join(jroot, "INBOX.jsonl")  # the keep arm: nothing takes the sleep lines in
inbox = len(open(inbox_file).read().splitlines()) if os.path.exists(inbox_file) else 0
folds = [i for i, l in enumerate(jl) if l.startswith("--- slept (topic closed)")]
began = next((i for i, l in enumerate(jl) if re.match(r"\d+\. ", l) and f"{last_topic}01.txt" in l), len(jl))
stream = open(os.path.join(run, "stream.jsonl"), encoding="utf8", errors="replace").read()
updates = []
for d in sorted(os.listdir(jroot)) if os.path.isdir(jroot) else []:
    p = os.path.join(jroot, d, "UPDATES.jsonl")
    if os.path.exists(p):
        updates += [{k: u[k] for k in ("pin", "by", "text")} for u in map(json.loads, open(p, encoding="utf8"))]
rec = {"variant": VARIANT, "arm": arm, "seed": seed, "rc": rc, "secs": round(time.time() - t0),
       "final": "new" if last == NEW else "old" if last == OLD else "neither", "last_line": last,
       "new_anywhere": NEW in lines, "old_anywhere": OLD in lines,
       "end_before_last_topic": any(l.startswith("END") for l in lines[:first_last]),
       "files_written": len(by), "files_right": right(files), "files": len(files),
       "sleeps_called": len(re.findall(r"^SLEEP ", journal, re.M)) + inbox,
       # the folds that came before the last topic began: after them the change is a pin and nothing else
       # (extension arms only; the keep arm never folds)
       "folds_before_last_topic": sum(i < began for i in folds), "folds_wanted": 2 if LATE else 1,
       "finished": bool(re.search(r"FINISHED", stream[-4000:]))}
if arm == "0.3.0":
    rec["updates"] = updates
    rec["update_right"] = any(u["pin"] == 1 and NEW in u["text"] and OLD not in u["text"] for u in updates)
print(json.dumps(rec, indent=1))
open(os.path.join(HERE, "correction-results.jsonl"), "a").write(json.dumps(rec) + "\n")
