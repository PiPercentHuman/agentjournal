import type { EngineInterface, Register } from 'claude-code'
import {
  entry, fold, HOW, MAX_CLEARS, older, pinUpdates, sleepEntry, topicDone, type Update, wakeText, withUpdates,
} from './journal'

const DIR = '.agentjournal'
const NL = String.fromCharCode(10)
const pins: string[] = []
const updates: Update[] = []
const journal: string[] = []
let folds = 0
let clears = 0
let woke = false // the context was just cleared: the next conversation opens on the wake-up

async function save($: EngineInterface) {
  const pinned = withUpdates(pins, updates).map((p, i) => `### ${i + 1}${NL}${p}${NL}`).join(NL)
  await $.fs.write(`${DIR}/PINNED.md`, pinned)
  await $.fs.write(`${DIR}/JOURNAL.md`, journal.join(NL) + NL)
}

// A topic is done: clear the conversation and go on from the pins and the journal.
// Runs once the session is idle, after the turn that ended the topic.
async function clearAndGoOn($: EngineInterface) {
  try {
    await $.command.run({ command: 'clear' })
    await $.prompt.submit({ text: 'Continue from the journal.' })
  } catch (err) {
    woke = false
    await $.fs.write(`${DIR}/CLEAR-ERROR.md`, String(err))
  }
}

export const register: Register = on => {
  // Pin what the person typed, word for word; the mod's own "continue" is not a pin.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'plugin') pins.push(e.text)
    await save($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Journal what the agent did: one line per action, never what came back.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      const { tool, tool_use_id, consent, agentId, ...input } = e as Record<string, unknown>
      const failed = result.deny !== undefined || result.isError === true
      journal.push(entry(journal.length + 1, String(tool), input, failed))
      await save($)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The end of a turn: file any instruction the agent rewrote, and when it says
  // a topic is done, journal what it found and clear the context.
  // Nothing to approve: the agent writes plain lines.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.isAborted || e.reason !== 'answer') return done
    updates.push(...pinUpdates(e.answer, pins.length + 1))
    const summary = topicDone(e.answer)
    if (summary !== null && clears < MAX_CLEARS) {
      clears += 1
      woke = true
      journal.push(sleepEntry(journal.length + 1, summary))
      void clearAndGoOn($)
    }
    await save($)
    return done
  }).catch(($, e, next) => next(e))

  // Every conversation opens on how to end a topic;
  // after a clear, on the whole wake-up.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const text = woke ? wakeText(withUpdates(pins, updates), journal, 'clear') : HOW
    if (woke) await $.fs.write(`${DIR}/CLEAR-${clears}.md`, text)
    woke = false
    return { ...r, blocks: [...r.blocks, { name: 'agentjournal', text }] }
  }).catch(($, e, next) => next(e))

  // The context is full. Answer in Claude Code's place: no summary is written
  // and no model is called. What stands afterwards is the pins, the journal
  // and the last few steps.
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    const rows = e.messages ?? []
    const kept = fold(rows)
    if (kept === null) return { skip: `${$.plugin.name}: nothing older than the last steps` }
    if (pins.length === 0 && rows[0]?.role === 'user') pins.push(rows[0].text)
    folds += 1
    const wake = wakeText(withUpdates(pins, updates), older(journal, kept.tail))
    await $.fs.write(`${DIR}/FOLD-${folds}.md`, wake)
    return { messages: [{ role: 'user', text: wake, toolUses: [] }, ...kept.tail] }
  }).catch(($, e, next) => next(e)) // if the fold fails, Claude Code compacts as usual
}
