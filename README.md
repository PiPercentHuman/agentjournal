# AgentJournal

**Pin what you were told. Journal what you did. Sleep when your head is full.**

Coding agents lose things in long jobs: a rule you gave at the start, how far they got, a number they were
counting. They lose them when the context fills and gets cut (a summary, a compaction, a new session). People get
through long jobs without remembering every word because they keep three things: **the instructions pinned where they
can see them, a diary of what they did, and sleep** - after which they wake up, read both, and carry on.

AgentJournal gives an agent the same three things:

| | What it is | Why |
|---|---|---|
| **PIN** | every message you wrote, word for word, never rewritten | a rule you gave once is exactly what a summary drops |
| **JOURNAL** | one line per action: what the agent *did*, not what it *read* | the trail of actions carries the job's state (and its counts); file contents are what fill the context |
| **SLEEP** | when the agent finishes a topic (it runs `agentjournal sleep`) or the context is full, fold everything older into the journal and wake up from pins + journal | the agent continues from its own notes, not from a summary somebody else wrote |

## What we measured

Local model (Qwen3.5-9B, Q4) on a long, checkable job: read N note files one at a time, write each key, follow two
rules given once in the first message (a format rule; a running count to write as a total at the end), then write an
exact final line. Every trial is in `benchmark/results.jsonl` (169 trials).

**24 files (fits a 30K window), 10 worlds each:**

| how the context is handled | finished in order | right total | all of it right | largest request |
|---|---|---|---|---|
| keep everything | 10 | 8 | 8 | 19.6K |
| pi's compaction (summary) | 7 | 3 | 1 | 10.8K |
| model edits its own context (the "context language model" idea, via pi-clm) | 0 | 0 | 0 | 12.1K |
| **AgentJournal** (pins + journal + sleep) | **10** | **10** | **8** | 9.5K |

The AgentJournal row is the research version (`benchmark/research-extension.ts`, mode `sleep`). The released
extension (`pi/extensions/agentjournal.ts` 0.1.1, same design, pi's compaction left on) on 3 of those worlds:
3/3 finished, 2/3 right total, 2/3 all of it right.

**60 files (longer than every window), 3 worlds each:** keeping everything stopped at file 31-32 every time;
compaction stopped at 20, 29 and 44. **AgentJournal finished all 60 files every time** in the research version (3/3)
and the released 0.1.1 (3/3). The running total is where it is weak at this length: right in 2/3 (research) and 1/3
(0.1.1; it wrote 4 twice against a true 3). Over all 12 runs of this design at 60 files, including earlier builds, the
total was right 7 times. (Build 0.1.0 stopped once at file 54: pi sized the reply from its full uncut history and left
a 1-token answer; 0.1.1 raises the reply limit to what the trimmed request leaves.)

## Sleep when a topic is done (0.2)

Waiting for a full context is waiting for the same moment a compaction picks: somewhere in the middle of the work.
A person sleeps after the day's work is done. In 0.2 the agent decides: when a topic is finished it runs

```bash
agentjournal sleep "topic 1 done: a01-a08 written; urgent so far: 2 (a03.txt, a06.txt)"
agentjournal note  "files changed so far: billing.ts, users.ts"     # any fact it must keep, any time
agentjournal status                                                 # where the journal is, topics closed so far
```

and the topic line goes into the journal, then:

| where | what happens after `agentjournal sleep` |
|---|---|
| **pi** | the extension folds everything but that one step into the journal at once, in the same session, and the agent carries on |
| **Claude Code** | the agent ends its turn; you see "safe to /clear"; `/clear` gives a blank context that wakes up from the same pins and journal (a `/clear` without a sleep stays blank) |
| **Codex, Copilot** | the topic is journaled and the agent is told to end its turn; clearing is up to you |

Claude Code's `/clear` can only be typed by you; no hook, tool or command can run it, so there the agent can choose the
moment but not press the key.

Measured on pi (same 9B model, two topics of 8 files, the count carried across both, size-triggered sleep switched off
so only the agent's own sleep could fold): 3 of 3 runs called `sleep` after the last file of topic 1, folded right
there (16, 22 and 16 steps became journal lines), and then got all 16 keys and the total across both topics right
(`benchmark/topic_sleep_test.py`, `benchmark/topic-results.jsonl`). The prompt told the agent when to sleep; whether
an agent picks topic boundaries by itself from the startup note alone is not measured yet.

Compute: AgentJournal read about 21K tokens per 24-file job against 17K for keeping everything and 23K for compaction,
because between sleeps it only appends (the server reuses its cache).

## What it is not

- **One small model, synthetic tasks.** Not yet measured on real coding sessions or on large models.
- **Instructions alone do not work on small models.** As `AGENTS.md` text only, the 9B model never wrote a single
  note (8 of 8 runs) and failed every 60-file job. AgentJournal works where **code** does the pinning and journaling: the pi
  extension, or the hooks below. Strong models may follow the instructions; that is untested here.
- **It does not clear a hook-only agent's context by itself.** Claude Code, Codex and Copilot keep their context
  until they compact or you `/clear`; AgentJournal makes either safe, because the pins and the journal are put back, and
  in Claude Code it tells you when the agent has closed a topic. Only pi (and Hermes, not yet ported) let AgentJournal
  replace the context itself.
- **A running count is not reliable at length.** It holds on the 24-file job but at 60 files it was right in about half
  the runs. If the job needs a number at the end, have the agent recount it from its output.
- **Rules applied at length still slip** on a small model (the format rule was missed on some files while it was in
  plain view): that is the model, not the memory.

## Install

### pi - the full version (real sleep)
```bash
pi install git:github.com/PiPercentHuman/agentjournal     # add AgentJournal to your pi
pi -e ./pi/extensions/agentjournal.ts               # or load it once from a clone of this repo
```
`agentjournal pi` (or `npm i -g` this repo, then `agentjournal` with any pi options) starts pi with AgentJournal
loaded. The extension cancels pi's own size-triggered compaction (AgentJournal sleeps instead), puts the
`agentjournal` command on the agent's PATH, and writes the pins and the full journal to `.agentjournal/<session>/`.
Settings: `AGENTJOURNAL_SLEEP_TOKENS` (9000), `AGENTJOURNAL_KEEP_STEPS` (3).

### Claude Code - plugin (pins + journal + wake-up)
The `plugin/` folder is a Claude Code plugin: hooks pin each of your messages, journal each tool call, tell the agent
at startup how to close a topic, show "safe to /clear" when it has, and put pins and journal back after compaction,
`/resume` or that `/clear`; plus the AgentJournal skill and the `agentjournal` command (`plugin/bin/`).

```
/plugin marketplace add PiPercentHuman/agentjournal
/plugin install agentjournal@agentjournal
```

Or for one session from a clone: `claude --plugin-dir ./plugin`. To keep it on for one project without the plugin: copy
`plugin/hooks/agentjournal-hook.mjs` and `plugin/bin/agentjournal.mjs` to `.claude/hooks/`, merge
`install/claude-code/settings.json` into `.claude/settings.json`, and copy `plugin/skills/agentjournal/` to
`.claude/skills/`. The notes go to `.agentjournal/<session>/` in the project (add it to `.gitignore`); after a sleep
and `/clear`, the new session keeps writing to the same folder.

When you see "safe to /clear", run it: you get an empty context that wakes up from the notes, with no summary in
between. You can also `/clear` whenever the context is heavy, but a `/clear` the agent did not ask for starts blank.

### Codex CLI and GitHub Copilot - hooks
Copy `plugin/hooks/agentjournal-hook.mjs` somewhere stable, put its absolute path into `install/codex/hooks.json`
(→ `.codex/hooks.json`) or `install/copilot/agentjournal.json` (→ `.github/hooks/`). Copilot has no event after
compaction, so the hook marks `preCompact` and hands the wake-up to the model on the next tool call. Not yet tested
in Codex or Copilot themselves; the hook was tested against each tool's documented payloads.

### Any other agent - instructions
Paste `AGENTS-snippet.md` into `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or your rules file, or install `SKILL.md` as a
skill. Weakest form: it only works if the model follows it (see above).

## Big jobs: churn with fresh workers

For a lot of material (a database, thousands of files), the agent should not read it all in its own context. It
gives each chunk to a fresh worker (sub-agent, sub-task, new session) with the pins, and journals the one line the
worker returns. The worker's context is thrown away; the main context grows by one line per chunk.

## Credits

Built on [pi](https://github.com/earendil-works/pi) (MIT). The benchmark compares against
[pi-clm](https://github.com/lolipopshock/pi-clm) (MIT), the pi extension for the Context Language Models paper
(Shao et al., 2026). The design draws on how human memory consolidates: anchors, a record of actions, and sleep.
## Files

- `package.json`: makes the repo a pi package (`pi install git:...`) with the `agentjournal` command.
- `.claude-plugin/marketplace.json`: makes the repo a Claude Code plugin marketplace with one plugin, `./plugin`.
- `SKILL.md`, `AGENTS-snippet.md`: the instructions, for any agent.
- `plugin/`: the Claude Code plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/agentjournal-hook.mjs`,
  `skills/agentjournal/SKILL.md`) and the `agentjournal` command (`bin/agentjournal.mjs`, with `sh` and `.cmd`
  shims). The one hook script also serves Codex and Copilot.
- `install/`: hook configs for a Claude Code project, Codex and Copilot.
- `pi/`: the pi extension (`extensions/agentjournal.ts`) and the pi launcher (`bin/agentjournal.mjs`, run by
  `agentjournal pi`).
- `benchmark/`: the harness as run (`pilot.py`; paths assume our layout), `run_full.sh` and `run_long.sh`, the
  research extension with all 15 variants we screened (`research-extension.ts`), and every trial in `results.jsonl`.
  Labels in that file: `control` keeps everything, `compaction` is pi's compaction, `clm` is pi-clm, `anchor` with
  `amode` is a research variant (`sleep` is the design that shipped), `dreamlog` is the instructions-only condition
  (AgentJournal's earlier working name), and `shipped` with a `"release"` tag is this package's
  extension. A trial is scored by plain code from the answers file it wrote; `score` holds the result.

Run on 2026-10-05 and 2026-10-06 with pi 1.0.3 and pi-clm 1.0.0. Model: Qwen3.5-9B (unsloth Q4_K_M GGUF) served by
llama.cpp (PrismML build b10709) with a 32K context, temperature 0.7, top_p 0.8, top_k 20, presence penalty 1.5,
thinking off.

MIT licence.
