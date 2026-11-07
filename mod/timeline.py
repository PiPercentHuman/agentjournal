"""Turn each trial's raw stream and meter log into one small timeline file the pictures are drawn from.

  python timeline.py            writes runs/trials/<tag>/timeline.json for every recorded trial whose scratch exists

A timeline is a list of events in the order they happened, each with the seconds since the job began:
  ["read", secs, file_number]            the agent opened a note file
  ["write", secs, file_number, key]      it appended a line to answers.txt (key as written, capitals kept)
  ["other", secs, command]               any other shell command
  ["say", secs, text]                    visible text the agent wrote
  ["fold", secs, rows_before, rows_after, summary_tokens]     the context was compacted or folded
Times come from the meter mod (when each request finished); the order inside a request is the stream's own.
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRATCH = HERE.parents[1] / "experiment" / "runs"


def build(tag):
    stream = SCRATCH / tag / "stream.jsonl"
    meter = HERE / "runs" / "trials" / tag / "meter.jsonl"
    if not stream.exists() or not meter.exists():
        return None
    log = [json.loads(l) for l in meter.read_text("utf8", errors="replace").splitlines() if l.strip("\x00").strip()]
    steps = [r for r in log if r["kind"] == "step"]
    folds = [r for r in log if r["kind"] == "compact" and not r.get("skip")]
    t0 = min(r["at"] for r in log)
    # the stream's blocks, grouped per request by the message id
    groups, order = {}, []
    for line in stream.read_text("utf8", errors="replace").splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "assistant":
            continue
        mid = e["message"].get("id")
        if mid not in groups:
            groups[mid] = []
            order.append(mid)
        groups[mid] += e["message"].get("content", [])
    events = []
    for k, mid in enumerate(order):
        at = (steps[min(k, len(steps) - 1)]["at"] - t0) / 1000 if steps else 0.0
        for c in groups[mid]:
            if c.get("type") == "text" and c["text"].strip():
                events.append(["say", round(at, 1), " ".join(c["text"].split())[:400]])
            elif c.get("type") == "tool_use" and c["name"] == "Read":
                m = re.search(r"n(\d+)\.txt", str(c["input"].get("file_path", "")))
                events.append(["read", round(at, 1), int(m.group(1))] if m else ["other", round(at, 1), "Read " + str(c["input"].get("file_path"))[:80]])
            elif c.get("type") == "tool_use" and c["name"] == "Bash":
                cmd = str(c["input"].get("command", ""))
                found = re.findall(r'echo\s+"n(\d+)\.txt\s+(\S+)"\s*>>\s*answers\.txt', cmd)   # one command may write several lines
                for num, key in found:
                    events.append(["write", round(at, 1), int(num), key])
                if not found:
                    events.append(["other", round(at, 1), cmd[:160]])
    for f in folds:
        events.append(["fold", round((f["at"] - t0) / 1000, 1), f["before"], f.get("after"),
                       (f.get("usage") or {}).get("output_tokens")])
    events.sort(key=lambda e: e[1])                      # stable: order inside one second is kept
    requests = [[round((s["at"] - t0) / 1000, 1),
                 sum((s["usage"] or {}).get(k, 0) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))]
                for s in steps if s.get("usage")]
    return {"tag": tag, "secs": round((max(r["at"] for r in log) - t0) / 1000, 1), "events": events, "requests": requests}


if __name__ == "__main__":
    n = 0
    for d in sorted((HERE / "runs" / "trials").iterdir()):
        t = build(d.name)
        if t:
            (d / "timeline.json").write_text(json.dumps(t), "utf8")
            n += 1
    print(f"{n} timelines written")
