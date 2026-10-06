# Two-topic pi run: does the model call `agentjournal sleep` between topics, does pi fold right then, and does the
# urgent count survive the fold? Needs llama-server on 127.0.0.1:8090 serving qwen35-9b. Size-triggered sleep is switched off
# (AGENTJOURNAL_SLEEP_TOKENS=100000). Usage: python topic_sleep_test.py <seed>
import json, os, random, re, shutil, subprocess, sys, time

seed = int(sys.argv[1])
PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")  # this repository
EXT = os.path.join(PKG, "pi", "extensions", "agentjournal.ts")
PI = os.environ.get("PI_DIR", ".")  # a folder with @earendil-works/pi-coding-agent in node_modules
CLI = os.path.join(PI, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
HERE = os.path.dirname(os.path.abspath(__file__))
SYL = ["ba", "ko", "ri", "tu", "ne", "sa", "vi", "lo", "dra", "mek", "pon", "zel", "fir", "gan", "hul", "qua"]
WORDS = "the river keeps a record of every season that passes through the valley and nobody reads it".split()

r = random.Random(seed)
files = []
for topic, urgent in (("a", {3, 6}), ("b", {4})):
    for i in range(1, 9):
        key = "".join(r.choice(SYL) for _ in range(3))
        lines = [" ".join(r.choice(WORDS) for _ in range(12)).capitalize() + "." for _ in range(30)]
        lines.insert(r.randrange(4, 26), f"KEY: {key}")
        if i in urgent:
            lines.insert(r.randrange(2, 28), "STATUS: URGENT")
        files.append({"name": f"{topic}{i:02d}.txt", "key": key, "urgent": i in urgent, "text": "\n".join(lines) + "\n"})

PROMPT = (
    "Two topics, done in order. Topic 1 is notes/a01.txt to notes/a08.txt. Topic 2 is notes/b01.txt to notes/b08.txt. "
    "Use those relative paths exactly. Each file has one line that starts with KEY:. For each file, one at a time: read it "
    "with the read tool, then add one line to answers.txt with bash, like this: echo \"a01.txt thekey\" >> answers.txt . "
    "Do not read two files before writing, and do not write a script that does them all.\n\n"
    "Rules for the whole job, which I will not repeat:\n"
    "1. If a file contains the line STATUS: URGENT, write its key in UPPERCASE.\n"
    "2. Keep count of how many files contain STATUS: URGENT, across both topics.\n"
    "3. When topic 1 is finished, close it by running this in bash, filled in: "
    "agentjournal sleep \"topic 1 done: a01-a08 written; urgent so far: <count> (<file names>)\" . Then go on with topic 2.\n"
    "4. After the last file of topic 2, add a line: TOTAL <urgent count across both topics>. Then add a final line that "
    "says exactly: END 7Q-PELICAN\n\n"
    "When that final line is written, reply with the single word FINISHED.")

run = os.path.join(HERE, "topic-runs", f"s{seed}")
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
json.dump({"compaction": {"enabled": True, "reserveTokens": 6144, "keepRecentTokens": 3000}}, open(os.path.join(agent, "settings.json"), "w"))
env = dict(os.environ, PI_CODING_AGENT_DIR=agent, PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0",
           AGENTJOURNAL_SLEEP_TOKENS="100000")
env.pop("AGENTJOURNAL_ROOT", None)
cmd = ["node", CLI, "--mode", "json", "-p", "--model", "local/qwen35-9b", "--thinking", "off", "--no-context-files",
       "--no-skills", "--no-prompt-templates", "-ne", "--session-dir", sess, "-e", EXT, PROMPT]
t0 = time.time()
with open(os.path.join(run, "stream.jsonl"), "wb") as out, open(os.path.join(run, "stderr.log"), "wb") as err:
    try:
        rc = subprocess.run(cmd, cwd=work, env=env, stdout=out, stderr=err, timeout=20 * 60).returncode
    except subprocess.TimeoutExpired:
        rc = "timeout"

answers = open(os.path.join(work, "answers.txt")).read() if os.path.exists(os.path.join(work, "answers.txt")) else ""
lines = [l.strip() for l in answers.splitlines() if l.strip()]
by = {l.split()[0]: l.split()[1] for l in lines if len(l.split()) >= 2 and l.split()[0].endswith(".txt")}
ok = sum(by.get(f["name"]) == (f["key"].upper() if f["urgent"] else f["key"]) for f in files)
jdir = os.path.join(work, ".agentjournal")
journal = ""
for d in sorted(os.listdir(jdir)) if os.path.isdir(jdir) else []:
    p = os.path.join(jdir, d, "JOURNAL.md")
    if os.path.exists(p):
        journal += open(p, encoding="utf8").read()
rec = {"seed": seed, "rc": rc, "secs": round(time.time() - t0), "files_written": len(by), "files_right": ok,
       "total_ok": "TOTAL 3" in lines, "total_line": next((l for l in lines if l.upper().startswith("TOTAL")), None),
       "end_ok": bool(lines) and lines[-1] == "END 7Q-PELICAN",
       "sleep_lines": re.findall(r"^SLEEP .*$", journal, re.M), "folds": re.findall(r"^--- slept.*$", journal, re.M),
       "sleep_before_b01": answers.find("b01.txt") > -1 and bool(re.search(r"^SLEEP", journal, re.M))}
print(json.dumps(rec, indent=1))
open(os.path.join(HERE, "topic-runs", "results.jsonl"), "a").write(json.dumps(rec) + "\n")
