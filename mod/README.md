# A memory for long agent jobs, as a Claude Code mod

Part of [AgentJournal](../README.md). This folder is the mod (0.4.0), the race it was measured in, and all 30 runs.

Claude Code mods (released 2026-10-01) run inside Claude Code. One event they can handle is `session.compact`,
fired when the conversation is about to be compacted, and a mod may answer it with messages of its own. This
folder holds a mod that does: it keeps your prompts word for word (pins), one line per action the agent took
(a journal), and the last six rows as they were, and hands that back as the conversation. No model is called.
Since 0.4.0 it also clears the conversation itself when the agent says a topic is done, and carries on from the
pins and the journal (below).

## What is here

| path | what it is |
| --- | --- |
| `mods/agentjournal/` | the mod, 0.4.0: `hooks/register.ts` (five hooks) and `hooks/journal.ts` (plain functions, tested with `claude plugin test`) |
| `mods/plain-cut/` | the control: the same takeover with only the first message and the last six rows |
| `mods/meter/` | changes nothing; logs every request's tokens and every fold. Loaded beside every contender |
| `hooks-0.2.1/` | AgentJournal 0.2.1, the release before the mod, as settings hooks |
| `world.py` | the job: a seeded folder of note files, three rules given once, a scorer that is plain code |
| `trial.py`, `run.py` | one headless Claude Code job; a grid of them |
| `runs/*.jsonl` | one record per job, with the answers file the agent wrote |
| `runs/trials/<job>/` | the meter's log, a timeline of the job, and the mod's own files (pins, journal, each fold) |
| `replay.py` | scores every record again and re-adds every token figure from the meter logs |

## Try the mod

```
claude --plugin-dir mods/agentjournal
```

Claude Code's `/plugin` screen then lists it as the active mod ("1 mod active · agentjournal"), recorded in a real terminal in
`runs/plugin-capture.json`.
Claude Code writes the plugin API's type declarations into `mods/agentjournal/.claude-plugin/types/` each time it loads the
mod; they are its own file and are not shipped here.

Read it first. A mod is unsandboxed code with your permissions. `claude plugin validate mods/agentjournal` lists
every call it makes (one: it writes files, into `.agentjournal/` beside your work).

## Topic ends clear by themselves (0.4.0)

When the agent finishes one topic of a job, it ends its answer with a plain line:

```
TOPIC DONE: <what it did and found, with every value it still needs>
```

The mod journals that line, runs `/clear` itself once the turn is over, and starts the next turn; the fresh
conversation opens on your instructions word for word and the journal. Nobody types `/clear`, and there is no tool to
approve: the mod reads the line from the answer. Every action the agent takes afterwards still goes through your own
permission settings. A session clears itself at most 20 times. A line `PIN UPDATE <n>: <the instruction as it stands
now>` files a changed instruction under the prompt it changes, as AgentJournal 0.3.0 does.

## Run the race

```
python trial.py journal 1 --files 60 --lines 120      # one job; needs Claude Code 2.1.287 or later, logged in
python run.py --contenders shipped,journal --seeds 1-6 --files 60 --lines 120
python replay.py                                    # no model needed
```

`trial.py` makes built-in compaction fire early (`CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`); in our runs it fired at
about 66,000 tokens. Each job spends your plan's usage or your API key.

## Results

30 jobs: `claude-haiku-5-5`, 60 files of 120 lines, 7 urgent files a world, 6 seeded worlds for each contender.
Perfect means every key, every capital, the total and the last line. Costs are list prices as Claude Code reported
them; all figures but the first column are medians of the six worlds.

| contender | perfect | cost a job | time | folds | summary tokens written | tokens re-read |
| --- | --- | --- | --- | --- | --- | --- |
| Keep everything | 6 of 6 | 75¢ | 174 s | 0 | 0 | 14.3 M |
| Claude Code's own summary | 5 of 6 | 13¢ | 230 s | 5 | 13,852 | 5.2 M |
| Summary plus the 0.2.1 hooks | 6 of 6 | 15¢ | 294 s | 6 | 18,698 | 5.7 M |
| A plain cut | 3 of 6 | 11¢ | 205 s | 4 | 0 | 5.6 M |
| AgentJournal as a mod | 6 of 6 | 9¢ | 175 s | 4 | 0 | 4.1 M |

Six worlds cannot separate 5 of 6 from 6 of 6. On being right, the mod and Claude Code's own summary tie; the
mod cost less in each of the six worlds.

## What is not here, and why

- **The default compaction point.** Left alone, this model compacts near a million tokens. A job that overflows
  that is several dollars a run, so compaction was triggered early for every contender that compacts.
- **Other models, other jobs, more than one prompt a job.** Not run.
- **The first build of the mod.** It listed the kept steps twice and was perfect in fewer worlds; its records are in
  `runs/_superseded/`. The runs in the table are the fixed build.
- **One tidy-up after the runs.** The step that trims the journal to the rows no longer in view was moved from
  `register.ts` into `journal.ts` as `older()`, with a test. The six mod runs used the earlier layout of the same logic.
- **The raw streams.** Each job's full stream is not shipped (size); the meter log and the timeline are.
