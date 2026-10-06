---
name: agentjournal
description: "Keep a long job on track across context limits, compaction and new sessions, the way a person does: pin what you were told, word for word; journal what you did, one line per action; and when your head is full, sleep - then re-read the pins and the journal and continue from them, not from what you remember. Use for any task that may outlive the context window: long refactors, multi-file edits, data processing, multi-step research, or whenever a rule given early must still hold at the end."
---

# AgentJournal

A person working through a long job does not keep the transcript in their head. They keep three things:
**the instructions, pinned where they can see them; a diary of what they did; and sleep,** after which they
wake up, read both, and carry on. Your context gets cut the same way (a limit, a compaction, a new session), and
what you "remember" afterwards is a summary somebody else wrote. AgentJournal makes your own notes the truth.

Keep two files in a `.agentjournal/` folder in the working directory.

## 1. PIN: what you were told, word for word

`.agentjournal/PINNED.md` - every instruction the user gives, **copied exactly**, numbered, in the order given.

- Write it before you start the work. Add to it whenever the user adds or changes an instruction.
- Never summarise, reword or delete a pin. If the user cancels one, add a new pin that says so.
- A rule you were given once (a format, a limit, a final step) is exactly what a summary loses. The pin keeps it.

## 2. JOURNAL: what you did, one line per action

`.agentjournal/JOURNAL.md` - after every action, append one line: **what you did and what came of it**, short.

```
14. read src/api/orders.ts - no deprecated calls
15. edited src/api/users.ts - replaced fetchAll() with paginate() (files changed so far: billing.ts, users.ts)
```

- Journal what you **did**, not what you **read**: the file names, the decision, the value you wrote. Not file contents.
- Anything a pin asks you to keep track of (a count, a list, a total) goes on the line where it changes, as the
  items themselves (`files changed so far: billing.ts, users.ts`), not just a number.
- Never rewrite earlier lines. The journal is append-only.

## 3. SLEEP: when your head is full, fold it down and wake up from the notes

Sleep when your context is getting long, when the tool tells you it compacted, or at the start of any new session:

1. Read `PINNED.md` and the end of `JOURNAL.md`. **They are the truth; your recollection is not.**
2. If the journal is long, append one fold line that restates the state from the journal itself:
   `SLEEP after 40: done steps 1-40; files changed: billing.ts, users.ts, cart.ts (3); next: step 41`.
   Count from the journal lines, never from memory.
3. Continue from the next step the journal points to.

**Close each topic yourself.** Do not wait for the context to fill: that moment falls in the middle of the work. When
a part of the job is finished and stands on its own, and the `agentjournal` command is installed, run
`agentjournal sleep "<what the topic came to, in one line: files, numbers, decisions>"` and end your turn. In pi the
context folds at once; in Claude Code the user is told it is safe to `/clear`, and you wake up from the pins and the
journal. `agentjournal note "<line>"` puts any fact you must keep into the journal at any time.

## 4. Bulk work: churn with fresh workers, keep only the journal

When the job is to go through a lot of material (many files, records, pages, a database), do not read it all in your
own context: that is what fills it. Hand each chunk to a fresh worker (a sub-agent, a sub-task, or a fresh session),
give the worker the pins, and take back **one line** for the journal. The worker's context is thrown away when it
finishes; yours grows by one line per chunk instead of one chunk per chunk.

```
JOURNAL: 31. worker: records 3001-3100 - 4 invalid (ids 3017, 3044, 3090, 3099); invalid so far: 11
```

## 5. Before you say "done"

- Check every pin against what you actually produced. **Read the output back**; do not check against memory.
- Recount any number from the journal or the output, and write the number you counted.
- Only then report the job finished.

## Why this works (and what it is not)

Measured on a local 9B model over a 24-file and a 60-file job: keeping the user's words verbatim kept every rule
and the place in the job; a journal of actions kept a running count correct where summaries lost it; and folding it
in batches kept the cost near that of keeping everything. Those results came from a harness enforcing these steps.
As instructions, AgentJournal only works if the model follows them: the 9B model we tested never did (it wrote no
notes in 8 of 8 runs); stronger models are untested. Where your tool has hooks or plugins, install those instead,
so code does the pinning and journaling. It is not a database or a retrieval system, and it does not stop your tool
from compacting.
