"""The job every contender gets: a folder of note files, three rules given once, and a scorer that is plain code.

A world comes from a seed. Each file is filler text with one "KEY: <word>" line; a few files also carry
"STATUS: URGENT". The agent reads the files in order and writes one line per file to answers.txt.

The three rules are in the first message and nowhere else:
  1. the key of an URGENT file is written in UPPERCASE
  2. count the URGENT files and write "TOTAL <n>" after the last file   (a fact carried across the whole job)
  3. end on one exact line

Nothing here calls a model. score() reads answers.txt and nothing else.
"""
import random

END_LINE = "END 7Q-PELICAN"

WORDS = ("the river keeps a record of every season that passes through the valley and nobody reads it because "
         "people prefer the weather report from the town where reports are short and maps are drawn by hand "
         "with careful ink while the old ferry crosses twice a day carrying bread tools letters and rumours "
         "about a bridge that the council has promised since before the mill was closed for the winter").split()
SYL = ["ba", "ko", "ri", "tu", "ne", "sa", "vi", "lo", "dra", "mek", "pon", "zel", "fir", "gan", "hul", "qua"]


def urgent_set(n):
    """Which files are urgent: one early, the rest spread across the job, the last one two from the end."""
    k = max(3, n // 8)
    step = (n - 5) / (k - 1)
    return sorted({3} | {round(3 + step * i) for i in range(1, k - 1)} | {n - 2})


def world(seed, n, lines=40):
    r = random.Random(seed)
    urgent = set(urgent_set(n))
    files = []
    for i in range(1, n + 1):
        key = "".join(r.choice(SYL) for _ in range(3))
        body = [" ".join(r.choice(WORDS) for _ in range(13)).capitalize() + "." for _ in range(lines)]
        body.insert(r.randrange(5, lines - 5), f"KEY: {key}")
        if i in urgent:
            body.insert(r.randrange(2, lines - 2), "STATUS: URGENT")
        files.append({"name": f"n{i:02d}.txt", "key": key, "urgent": i in urgent, "text": "\n".join(body) + "\n"})
    return files


def prompt(n):
    return (f"There are {n} files, notes/n01.txt to notes/n{n:02d}.txt, in the folder you are already in. Use those "
            "relative paths exactly; never use an absolute path and do not list the folder. Each file has exactly one "
            "line that starts with KEY:. Work through them in order, one file at a time. For each file: read it with "
            "the Read tool, then add one line to answers.txt with Bash, like this: "
            "echo \"n01.txt thekey\" >> answers.txt . "
            "Do not read two files before writing, do not use subagents, and do not write a script that does them "
            "all.\n\n"
            "Three rules for the whole job, which I will not repeat:\n"
            "1. If a file contains the line STATUS: URGENT, write its key in UPPERCASE.\n"
            "2. Keep count of how many files contain STATUS: URGENT. After the last file, add a line: "
            "TOTAL <that number>\n"
            f"3. Then add one final line to answers.txt that says exactly: {END_LINE}\n\n"
            "When that final line is written, reply with the single word FINISHED.")


def score(files, answers):
    lines = [l.strip() for l in answers.splitlines() if l.strip()]
    by, order = {}, []
    for l in lines:
        parts = l.split()
        if len(parts) >= 2 and parts[0].lower().startswith("n") and parts[0].lower().endswith(".txt"):
            if parts[0].lower() not in by:
                order.append(parts[0].lower())
            by.setdefault(parts[0].lower(), parts[1])
    rows = []
    for f in files:
        got = by.get(f["name"])
        rows.append({"file": f["name"], "urgent": f["urgent"], "written": got is not None,
                     "key_ok": bool(got) and got.lower() == f["key"],
                     "case_ok": bool(got) and (got == f["key"].upper() if f["urgent"] else got == f["key"])})
    n_urgent = sum(f["urgent"] for f in files)
    written = sum(r["written"] for r in rows)
    out = {
        "files": len(files), "lines": len(lines), "files_written": written,
        "stopped_at": next((i for i, r in enumerate(rows) if not r["written"]), len(rows)),
        "in_order": order == [f["name"] for f in files][:len(order)],
        "keys_ok": sum(r["key_ok"] for r in rows),
        "urgent": n_urgent, "urgent_upper": sum(r["case_ok"] for r in rows if r["urgent"]),
        "plain_lower": sum(r["case_ok"] for r in rows if not r["urgent"]),
        "total_line": next((l for l in lines if l.upper().startswith("TOTAL")), None),
        "total_ok": f"TOTAL {n_urgent}" in lines,
        "end_ok": bool(lines) and lines[-1] == END_LINE,
    }
    out["finished"] = written == len(files)
    out["perfect"] = (out["finished"] and out["keys_ok"] == len(files) and out["urgent_upper"] == n_urgent
                      and out["plain_lower"] == len(files) - n_urgent and out["total_ok"] and out["end_ok"])
    return out
