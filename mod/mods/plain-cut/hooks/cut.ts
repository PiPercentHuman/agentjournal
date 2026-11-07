// The whole memory design of this mod: keep the first message, which holds
// what the person asked for, and the last few steps. Everything between goes.

export type Row = { role: 'user' | 'assistant' }

export const KEEP_LAST = 6

// Where the kept tail starts. It has to start on an assistant row, so that no
// tool result is kept without the call it answers.
export function tailStart<M extends Row>(rows: readonly M[], keep = KEEP_LAST): number {
  let i = Math.max(1, rows.length - keep)
  while (i < rows.length && rows[i].role !== 'assistant') i += 1
  return i
}

// Returns null when there is nothing between the first message and the tail.
export function cut<M extends Row>(rows: readonly M[], keep = KEEP_LAST): M[] | null {
  if (rows.length === 0 || rows[0].role !== 'user') return null
  const i = tailStart(rows, keep)
  if (i <= 1 || i >= rows.length) return null
  return [rows[0], ...rows.slice(i)]
}
