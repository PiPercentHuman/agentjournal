// AgentJournal's memory, as plain functions: no model is called anywhere here.
//
//   pins      what the person typed, word for word
//   journal   one line per action the agent took: the command, the file, the
//             query. Never what came back.
//   fold      when the context fills: the pins, the journal, and the last few
//             steps as they were. Everything the agent only read is let go.

export type Row = { role: 'user' | 'assistant'; toolUses?: readonly unknown[] }

export const KEEP_LAST = 6
const NL = String.fromCharCode(10)

export function oneLine(text: unknown, max = 200): string {
  const flat = String(text ?? '').split(/\s+/).join(' ').trim()
  return flat.length > max ? flat.slice(0, max - 3) + '...' : flat
}

// What was done, in one line.
export function summarise(input: Record<string, unknown>): string {
  const keys = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description']
  for (const key of keys) {
    if (input[key]) return oneLine(input[key])
  }
  return oneLine(JSON.stringify(input), 150)
}

export function entry(
  n: number,
  tool: string,
  input: Record<string, unknown>,
  failed: boolean,
): string {
  return `${n}. ${tool} ${summarise(input)}${failed ? ' - FAILED' : ''}`
}

// Where the kept steps start. They start on an assistant row, so no tool
// result is kept without the call it answers.
export function tailStart<M extends Row>(rows: readonly M[], keep = KEEP_LAST): number {
  let i = Math.max(1, rows.length - keep)
  while (i < rows.length && rows[i].role !== 'assistant') i += 1
  return i
}

// How the agent talks to the journal: two plain lines in its answer, no tool to call or approve.
export const HOW =
  'When one topic of the job is finished, end your answer with one line: TOPIC DONE: <what you did and found, ' +
  'with every value you will still need>. Your context is then cleared and you continue from the pins and the ' +
  'journal. When the user changes an earlier instruction, write one line: PIN UPDATE <pin number>: <that ' +
  'instruction as it stands now, in full>.'

// A runaway guard: no session clears itself more often than this.
export const MAX_CLEARS = 20

export type Update = { pin: number; by: number; text: string }

// The summary of a finished topic, or null when the answer does not end one.
export function topicDone(answer: string): string | null {
  const found = [...String(answer ?? '').matchAll(/^[ \t]*TOPIC DONE:[ \t]*(.+)$/gm)]
  const last = found.at(-1)?.[1]?.trim()
  return last ? last : null
}

// The instructions the agent rewrote as they stand now, filed under the pins they change.
export function pinUpdates(answer: string, by: number): Update[] {
  return [...String(answer ?? '').matchAll(/^[ \t]*PIN UPDATE[ \t]+(\d+):[ \t]*(.+)$/gm)]
    .map(m => ({ pin: Number(m[1]), by, text: (m[2] ?? '').trim() }))
    .filter(u => u.pin >= 1 && u.pin < by && u.text)
}

export function sleepEntry(n: number, summary: string): string {
  return `${n}. SLEEP ${oneLine(summary, 400)} - topic done, context cleared`
}

// Each pin in the user's words, with the versions that replace parts of it beneath (AgentJournal 0.3.0's form).
export function withUpdates(pins: readonly string[], updates: readonly Update[]): string[] {
  return pins.map((p, i) => [
    p,
    ...updates.filter(u => u.pin === i + 1).map((u, k) =>
      `#### ${i + 1}.${k + 1} updated by pin ${u.by} (how this part stands now; it replaces that part of pin ${i + 1})${NL}${u.text}`),
  ].join(NL))
}

// The one message that stands in for everything put away: after a fold (the last steps follow it, as they were)
// or after a topic ended and the context was cleared (nothing follows it).
export function wakeText(pins: readonly string[], journal: readonly string[], after: 'fold' | 'clear' = 'fold'): string {
  const clear = after === 'clear'
  return [
    clear
      ? 'AGENTJOURNAL WAKE-UP. You finished a topic and your context was cleared.'
      : 'AGENTJOURNAL WAKE-UP. The older part of this conversation has been put away to make room.',
    'The pins and the journal below were written as things happened. ' +
      'They are the truth; your recollection is not.',
    '',
    `## PINNED - the user's instructions, word for word (${pins.length})`,
    ...pins.map((p, i) => `### ${i + 1}${NL}${p}`),
    '',
    `## JOURNAL - your ${journal.length} actions so far, oldest first`,
    journal.length ? journal.join(NL) : '(no actions journaled yet)',
    '',
    clear
      ? 'What you read is gone on purpose; the SLEEP lines hold what you found. Go on with the next topic.'
      : 'What you read during those actions is gone on purpose. ' +
        'Your most recent steps are not in the journal: they follow below, as they were.',
    'Continue from these. Check every pin before you say you are done, ' +
      'and recount any number from the journal or the output, not from memory.',
    HOW,
  ].join(NL)
}

// Returns null when there is nothing older than the kept steps.
export function fold<M extends Row>(rows: readonly M[], keep = KEEP_LAST): { tail: M[] } | null {
  const i = tailStart(rows, keep)
  if (i <= 1 || i >= rows.length) return null
  return { tail: rows.slice(i) }
}

// The journal lines for everything older than the kept steps. Those steps are
// still in view as they were, so the journal stops where they start.
export function older<M extends Row>(journal: readonly string[], tail: readonly M[]): string[] {
  const calls = (row: M) => (row.role === 'assistant' ? row.toolUses?.length ?? 0 : 0)
  const inView = tail.reduce((n, row) => n + calls(row), 0)
  return journal.slice(0, Math.max(0, journal.length - inView))
}
