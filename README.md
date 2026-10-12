# AgentJournal

**Pin what you were told. Journal what you did. Sleep when your head is full.**

**Current version: 0.3.0** (the pi extension, the Claude Code plugin, the hooks for Codex and Copilot, and the
`agentjournal` command are one package with one version). Where 0.2.1 and 0.2.2 appear below, they are the releases
before it, kept in the tables to show what each change did.

**Video:** [how it works, and the runs behind the numbers below](https://www.youtube.com/watch?v=VtwJpJ0KM5E) (10 minutes).

A memory for coding agents on long jobs. Your instructions are kept word for word, every action gets one line in a
journal, and when the context is cut the agent reads both and carries on from where it was. It is measured against
compaction on a small local model, and it has carried a real Claude Code session across a `/clear` (both below).

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

The two AgentJournal runs that were not all right each had one key of 24 wrong.

The AgentJournal row is the research version (`benchmark/research-extension.ts`, mode `sleep`). The released
extension (`pi/extensions/agentjournal.ts` 0.1.1, same design, pi's compaction left on) on 3 of those worlds:
3/3 finished, 2/3 right total, 2/3 all of it right.

**60 files (longer than every window), 3 worlds each:** keeping everything stopped at file 31-32 every time;
compaction stopped at 20, 29 and 44. **AgentJournal finished all 60 files every time** in the research version (3/3)
and the released 0.1.1 (3/3). The running total is where it is weak at this length: right in 2/3 (research) and 1/3
(0.1.1; it wrote 4 twice against a true 3). Over all 12 runs of this design at 60 files, including earlier builds, the
total was right 7 times. (Build 0.1.0 stopped once at file 54: pi sized the reply from its full uncut history and left
a 1-token answer; 0.1.1 raises the reply limit to what the trimmed request leaves.) If a job needs a number at the
end, have the agent recount it from its output.

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
| **Claude Code** | you are asked first (Allow / Deny, with the topic line); on Allow the agent ends its turn and you get a "type /clear now" message plus a desktop notification; `/clear` gives a blank context that wakes up from the same pins and journal (a `/clear` without a sleep stays blank). On Deny it keeps working in the same context |
| **Codex, Copilot** | the topic is journaled and the agent is told to end its turn; clearing is up to you |

Claude Code's `/clear` can only be typed by you; no hook, tool or command can run it, so there the agent can choose the
moment and ask, but not press the key. Allowing it would take one hook field in Claude Code. We asked for it in
[anthropics/claude-code#99996](https://github.com/anthropics/claude-code/issues/99996): a 👍 there helps. Earlier
requests for it were closed by the inactivity bot, not declined:
[#16659](https://github.com/anthropics/claude-code/issues/16659), [#35150](https://github.com/anthropics/claude-code/issues/35150),
[#9118](https://github.com/anthropics/claude-code/issues/9118).

Measured on pi (same 9B model, two topics of 8 files, the count carried across both, size-triggered sleep switched off
so only the agent's own sleep could fold): 3 of 3 runs called `sleep` after the last file of topic 1, folded right
there (16, 22 and 16 steps became journal lines), and then got all 16 keys and the total across both topics right
(`benchmark/topic_sleep_test.py`, `benchmark/topic-results.jsonl`). The prompt told the agent when to sleep; whether
an agent picks topic boundaries by itself from the startup note alone is not measured yet.

Compute: AgentJournal read about 21K tokens per 24-file job against 17K for keeping everything and 23K for compaction,
because between sleeps it only appends (the server reuses its cache).

## When you change an instruction (0.3)

A memory that keeps the first plan and loses the correction keeps the wrong plan. Pins are never rewritten, so when
you change an instruction partway the old message and the new one are both kept. What makes the new one win:

- **The changed instruction is written out in full, under the pin it changes** (0.3.0). A short change ("use the
  other one instead") only makes sense beside the conversation it was said in, and that conversation is what gets
  cut. So when a message after the first arrives, the agent is asked whether it changes an earlier pin, and runs

  ```bash
  agentjournal update 1 "At the very end of the job add a final line that says exactly: END 4T-HERON"
  agentjournal same      # its answer when the message changes nothing earlier
  agentjournal pins      # the pins by number, one line each, with their updated versions
  ```

  From then on every wake-up shows the updated version as a sub-chapter of that pin:

  ```
  ### 1
  ... add a final line to answers.txt that says exactly: END 7Q-PELICAN ...

  #### 1.1 updated by pin 2 (how this part stands now; it replaces that part of pin 1 above)
  At the very end of the job add a final line that says exactly: END 4T-HERON

  ### 2 (after action 17)
  Use END 4T-HERON instead.
  ```

  The pins stay your words and nothing else. The sub-chapter is the agent's wording, kept in its own file
  (`UPDATES.jsonl`), and an update is refused when it is filed under the new message itself or only copies it.

  | where | how the agent is asked |
  |---|---|
  | **pi** | with the message, and again with each of its next steps until it answers, three times at most (`AGENTJOURNAL_ASK_UPDATES`, 0 turns it off). A sleep it asks for meanwhile waits for the answer, so the conversation is not folded away before the answer is read from it |
  | **Claude Code, Codex** | once with each message after the first (the hook adds one line to it), and once more when the agent closes a topic with `agentjournal sleep`, before the context is cleared |
  | **Copilot** | the hook returns the same line; if Copilot does not pass a hook's text on with a message, the agent has it from the start of the session, from every wake-up, and when it closes a topic |
  | **instructions only** | `SKILL.md` and `AGENTS-snippet.md` tell the agent to write the sub-chapter into `PINNED.md` itself |

- **The later pin stands** (0.2.2). The wake-up, and the memory block in pi, list the pins oldest first and say it in
  one line: where two pins disagree, the later one is what you want now.
- **Each pin says where in the job it arrived:** `### 4 (2026-10-06 11:16, after action 37)`. Journal lines and
  closed topics numbered below that were done before it, and the agent is told to check that work against the pin.
- **No pin is left out of a long session.** Before 0.2.2 a pin file over 8,000 characters woke up as the first pin
  and the latest ones, with a count in place of everything between, so a correction from the middle could be missing
  while the message it corrected was shown. Now the first and the latest pins are whole, and each pin between them
  shows its first 160 characters (a shorter one is whole), with the full text in the pin file.

Checked without a model: `node --test` builds sessions where the final line is changed partway, with and without an
updated version, sleeps, clears, and reads what the hook and the pi extension hand to the model (9 checks).

**Which one the model follows** (pi, the same 9B model, runs in `benchmark/correction-results.jsonl`). The first
message gives the exact final line of the job. A second message, sent when topic 1 is finished, changes that line and
has the agent close the topic with `agentjournal sleep`. The last line the agent writes says which of the two it
followed. *Recent*: two topics, so the final line is due at the end of the topic the change arrived with. *Late*:
three topics, so it is due two sleeps after the change, and the message that asks for it does not repeat it. Ten
worlds each, the same two or three messages in every row:

| | recent: ended on the new line | late: ended on the new line | late: also wrote a final line too early |
|---|---|---|---|
| nothing cut (no extension) | 10 of 10 | 10 of 10 | 1 of 10 |
| AgentJournal 0.2.1 (earlier release) | 10 of 10 | 10 of 10 | 4 of 10 |
| AgentJournal 0.2.2 (earlier release) | 10 of 10 | 9 of 10 | 5 of 10 |
| **AgentJournal 0.3.0 (current)** | not run | 10 of 10 | 1 of 10 |

- **The change survived the sleep in 39 of 40 runs on 0.2.1 and 0.2.2, and in 10 of 10 on 0.3.0.** Up to 0.2.2
  every fold came before the last topic began, so by then the change was a pin and nothing else. In 0.3.0 the second
  sleep waits for the agent's answer about the third message and came two steps into the last topic, still well
  before the final line.
- **The "later pin stands" line made no difference this test can show.** 0.2.1 already kept both messages in order,
  and this model followed the later one without being told. The one run that ended on the old line was a 0.2.2 run:
  it wrote the new line too early, after topic 2, and the old one at the very end.
- **What got worse was when, not which.** The first message says the final line comes at the very end and not
  before. In the late job, 9 of the 20 AgentJournal runs wrote a final line before the last topic as well, against 1
  of 10 with nothing cut. Three of those wrote the old line after topic 1, before the change had arrived.
- Every key right, recent then late: 7 and 7 of 10 with nothing cut, 9 and 7 on 0.2.1, 9 and 5 on 0.2.2, and 6 of
  10 on 0.3.0 (late only).

**A change too short to stand on its own is where it broke** (50 more runs, the late job). The second message
now opens with "Use END 4T-HERON instead." and nothing else about the change:

| | ended on the new line |
|---|---|
| nothing cut (no extension) | 5 of 10 |
| AgentJournal 0.2.2 (earlier release) | 1 of 10 |
| 0.2.2 with pin 1 marked `(pin 2 changes part of this: the final line)` by the test | 1 of 10 |
| 0.2.2 with the changed rule written out in full under pin 1 by the test | 10 of 10 |
| **AgentJournal 0.3.0 (current)**, the agent writes the updated version itself | 7 of 10 |

- **The short change fails half the time with nothing cut, and nine times in ten with AgentJournal.** A pin keeps
  your words, and these words need the conversation around them. In 3 of the 10 AgentJournal runs the agent wrote
  the new line once, earlier in the job, and still ended on the old one.
- **Marking the old pin did not help.** The mark in the third row was written by code, always correct, as soon as
  the change arrived: the most a marking command could do. It scored the same 1 of 10.
- **The updated version under the pin it changes did.** In the fourth row pin 1 and pin 2 are your words, untouched,
  and under pin 1 sits a sub-chapter, `#### 1.1 updated by pin 2`, holding rule 2 in full with the new line. The test
  wrote it by code, because it knew the answer: all 10 runs ended on the new line, better than keeping the whole
  conversation. That is the most a correct updated version can do.
- **0.3.0 is the same thing with the model doing the writing: 7 of 10.** It wrote an updated version in 9 of the 10
  runs, 8 of them under pin 1 with the new line in and the old line out. The three that missed: one never answered
  the question and ended on the old line; one wrote "after topic 2 is complete, add a final line ..." (the right line
  at the wrong time) and ended on the old line; one did topic 2 over again after the second sleep and wrote no final
  line. No run wrote the new line and went back to the old one.
- **A wrong or wordy updated version is the price.** Asked for the one instruction that changed, this model copied
  out the whole of pin 1 with the line changed in 6 of the 10 runs, which puts "do topic 1 now" back in front of it as
  if it still stood. With an earlier wording of the question, which asked for the whole instruction, the same job
  ended on the new line in 9 of 10 and one run skipped topic 2. At ten runs the test cannot tell those wordings apart
  (`benchmark/correction-earlier-wordings.jsonl` has those runs, and the 5 of a build before it that refused nothing:
  in 4 of them the model filed its "update" under the new message itself).

So a short change is no longer lost nine times in ten, and it is not as safe as a change written in full: "the final
line must now say exactly: ..." ended on the new line in 29 of 30 AgentJournal runs of the same job.

`benchmark/correction_table.py` prints all of these counts from the records (120 runs, and the 17 of the earlier
wordings). It is one small model on a made-up job, in pi. Not measured: the updated version in Claude Code, Codex or
Copilot (there the agent is asked once, and a larger model answers), and a change in the middle of a pin file long
enough to be cut short (the hook).

## In a real session

The numbers above are one small model on a made-up job. We also left the Claude Code hooks on for a real one: about
eleven hours of the session that built 0.2 and then went on to other work in the same project (Claude Opus 5.5,
2026-10-06). From the notes it left:

| | |
|---|---|
| actions journaled | 406 |
| messages pinned | 17 |
| topics the agent closed with `agentjournal sleep` | 1 |
| notes it wrote with `agentjournal note` | 0 |
| `/clear` followed by a wake-up | 1 |

After the `/clear` the new context held the pins, the closed topic and the last 40 actions, and nothing else. From
those the agent found the long build it had left running in the background, saw that it had stopped improving, and
moved it to its next step, without asking what it had been doing.

What that session showed that the benchmark could not:

- **The journal says what was done, not why.** A line is the command or the file. The reasons were in the project's
  own plan file, which the agent reread after waking. `agentjournal note` is for exactly those, and the agent did not
  use it once: if a decision has to last, tell the agent to note it.
- **The wake-up was 14.5 KB**, more than Claude Code shows inline, so it arrived as a short preview and a file to
  open. The agent opened it.
- **The `/clear` came more than a hundred actions after the sleep** and still woke up as "the end of a topic". A sleep you do not
  follow with `/clear` stays pending until the next `/clear`.
- **Three faults, all fixed in 0.2.1.** The notes followed the shell's working folder, so 167 of the 406
  actions and 2 of the 17 messages were written to 16 other folders where the wake-up did not look. Background-task
  events were pinned as if you had written them (36 of 53 pins). And the "this session slept" marker was one per
  project, so with two windows open a `/clear` in one would have woken up on the other's journal. The notes now go
  to the project folder wherever the agent `cd`s, only what you type is pinned, and the marker is kept per window.

Each session has its own folder, `.agentjournal/<session>/`, with its own pins and journal. A note or a sleep written
with the `agentjournal` command reaches only the session whose agent ran it.

One session is one session. It is not a measurement, and Codex and Copilot have not had even that.

## Install

### pi - the full version (real sleep)
```bash
pi install git:github.com/PiPercentHuman/agentjournal     # add AgentJournal to your pi
pi -e ./pi/extensions/agentjournal.ts               # or load it once from a clone of this repo
```
`agentjournal pi` (or `npm i -g` this repo, then `agentjournal` with any pi options) starts pi with AgentJournal
loaded. The extension cancels pi's own size-triggered compaction (AgentJournal sleeps instead), puts the
`agentjournal` command on the agent's PATH, and writes the pins and the full journal to `.agentjournal/<session>/`.
Settings: `AGENTJOURNAL_SLEEP_TOKENS` (9000), `AGENTJOURNAL_KEEP_STEPS` (3), `AGENTJOURNAL_ASK_UPDATES` (3: how often
the agent is asked whether your latest message changes an earlier pin; 0 never asks).

### Claude Code - plugin (pins + journal + wake-up)
The `plugin/` folder is a Claude Code plugin: hooks pin each of your messages, journal each tool call, tell the agent
at startup how to close a topic, show "safe to /clear" when it has, and put pins and journal back after compaction,
`/resume` or that `/clear`; plus the AgentJournal skill and the `agentjournal` command (`plugin/bin/`). From your
second message on, the hook also adds one line to each message asking the agent to write out any earlier instruction
the message changes (`agentjournal update`).

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
Copy `plugin/hooks/agentjournal-hook.mjs` and `plugin/bin/agentjournal.mjs` into the same stable folder (the hook
tells the agent to run the command from beside itself; with only the hook copied, `agentjournal sleep`, `note` and
`update` need `npm i -g` of this repo to be on the PATH). Put the hook's absolute path into `install/codex/hooks.json`
(→ `.codex/hooks.json`) or `install/copilot/agentjournal.json` (→ `.github/hooks/`). Copilot has no event after
compaction, so the hook marks `preCompact` and hands the wake-up to the model on the next tool call. Not yet tested
in Codex or Copilot themselves; the hook was tested against each tool's documented payloads.

### Any other agent - instructions
Paste `AGENTS-snippet.md` into `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or your rules file, or install `SKILL.md` as a
skill. Weakest form: it only works if the model follows it. The 9B model did not: as instructions only it wrote no
notes in 8 of 8 runs and failed every 60-file job. Stronger models may follow them; that is untested here.

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
- `test/`: checks with no model (`node --test`): what the wake-up holds after an instruction is changed partway,
  how the agent is asked for the updated version, and where that version is shown.
- `benchmark/`: the harness as run (`pilot.py`; paths assume our layout), `run_full.sh` and `run_long.sh`, the
  research extension with all 15 variants we screened (`research-extension.ts`), and every trial in `results.jsonl`.
  Labels in that file: `control` keeps everything, `compaction` is pi's compaction, `clm` is pi-clm, `anchor` with
  `amode` is a research variant (`sleep` is the design that shipped), `dreamlog` is the instructions-only condition
  (AgentJournal's earlier working name), and `shipped` with a `"release"` tag is this package's
  extension. A trial is scored by plain code from the answers file it wrote; `score` holds the result.
  The correction test is `correction_test.py` (`run_correction.sh` and `run_correction_terse.sh` run all of it, `correction_table.py` counts
  `correction-results.jsonl` and `correction-earlier-wordings.jsonl`); its arm `keep` cuts nothing, `0.2.1` and
  `0.2.2` are the extension as released (commits 8088bae and c414044), `marked` and `updated` are 0.2.2 with pin 1
  marked, or given its updated version, by the test, and `0.3.0` is the extension in this repository.

Run on 2026-10-05 and 2026-10-06 (the correction test on 2026-10-11 and 2026-10-12) with pi 1.0.3 and pi-clm 1.0.0. Model: Qwen3.5-9B (unsloth Q4_K_M GGUF) served by
llama.cpp (PrismML build b10709) with a 32K context, temperature 0.7, top_p 0.8, top_k 20, presence penalty 1.5,
thinking off.

MIT licence.
