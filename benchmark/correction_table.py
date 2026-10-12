# The tables in the README's "When you change an instruction", counted from correction-results.jsonl.
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
R = [json.loads(l) for l in open(os.path.join(HERE, "correction-results.jsonl"))]
# variant -> the arms run on it: the change written in full (recent, late), then as one short sentence (late-terse)
PLAN = {"recent": ("keep", "0.2.1", "0.2.2"), "late": ("keep", "0.2.1", "0.2.2", "0.3.0"),
        "late-terse": ("keep", "0.2.2", "marked", "updated", "0.3.0")}
assert len(R) == 120 and len({(r["variant"], r["arm"], r["seed"]) for r in R}) == 120
assert all(r["arm"] in PLAN[r["variant"]] for r in R)
assert all(r["rc"] == 0 for r in R), "a run that died is not a result"
# Up to 0.2.2 every fold happened before the last topic began: by then the change was a pin and nothing else. In 0.3.0 a
# sleep waits for the answer about the latest message, so the second fold can come a few steps into the last topic
# (two, in every run here); it still comes before the final line is written.
assert all(r["folds_before_last_topic"] == r["folds_wanted"] for r in R if r["arm"] not in ("keep", "0.3.0"))
assert all(r["folds_before_last_topic"] >= 1 for r in R if r["arm"] == "0.3.0")
assert all(r["folds_before_last_topic"] == 0 for r in R if r["arm"] == "keep")

print(f"{'':12}{'arm':8}{'runs':>5}{'new line':>10}{'old line':>10}{'no final line':>15}{'a final line too early':>24}{'every key right':>17}{'said FINISHED':>15}")
for v, arms in PLAN.items():
    for a in arms:
        g = [r for r in R if r["variant"] == v and r["arm"] == a]
        n = lambda f: sum(bool(f(r)) for r in g)
        assert len(g) == 10
        print(f"{v:12}{a:8}{len(g):>5}{n(lambda r: r['final'] == 'new'):>10}{n(lambda r: r['final'] == 'old'):>10}"
              f"{n(lambda r: r['final'] == 'neither'):>15}{n(lambda r: r['end_before_last_topic']):>24}"
              f"{n(lambda r: r['files_right'] == r['files']):>17}{n(lambda r: r['finished']):>15}")
full = [r for r in R if r["arm"] in ("0.2.1", "0.2.2") and r["variant"] in ("recent", "late")]
print(f"\nchange written in full, AgentJournal runs (0.2.1 and 0.2.2) that ended on the new line: {sum(r['final'] == 'new' for r in full)} of {len(full)}")
late = [r for r in full if r["variant"] == "late"]
print(f"late AgentJournal runs (0.2.1 and 0.2.2) with a final line before the last topic: {sum(r['end_before_last_topic'] for r in late)} of {len(late)}")
# The short change: who wrote the new line after topic 2 (while the change was one message old) and the old one at the end.
for a in PLAN["late-terse"]:
    g = [r for r in R if r["variant"] == "late-terse" and r["arm"] == a]
    back = [r for r in g if r["final"] == "old" and r["new_anywhere"]]
    print(f"late-terse {a}: wrote the new line earlier and ended on the old one: {len(back)} of {len(g)}")
# 0.3.0: the updated version is the model's own.
for v in ("late-terse", "late"):
    g = [r for r in R if r["variant"] == v and r["arm"] == "0.3.0"]
    wrote = [r for r in g if r["updates"]]
    print(f"{v} 0.3.0: wrote an updated version {len(wrote)} of {len(g)}; under pin 1 with the new line and without the old one "
          f"{sum(r['update_right'] for r in g)}; the whole of pin 1 copied out (over 500 characters) "
          f"{sum(any(len(u['text']) > 500 for u in r['updates']) for r in g)}")

E = [json.loads(l) for l in open(os.path.join(HERE, "correction-earlier-wordings.jsonl"))]
for build in sorted({r["build"] for r in E}):
    g = [r for r in E if r["build"] == build and r["variant"] == "late-terse"]
    print(f"earlier wording, {build}: late-terse runs {len(g)}, ended on the new line {sum(r['final'] == 'new' for r in g)}, "
          f"right updated version {sum(r['update_right'] for r in g)}")
