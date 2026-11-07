import { test, expect } from 'claude-code/testing'
import { cut, tailStart } from './cut'

const u = (n: number) => ({ role: 'user' as const, n })
const a = (n: number) => ({ role: 'assistant' as const, n })

// user, then assistant/user pairs: a prompt followed by tool calls and results
const job = (pairs: number) => [u(0), ...Array.from({ length: pairs }, (_, k) => [a(2 * k + 1), u(2 * k + 2)]).flat()]

test('keeps the first message and a tail that starts on an assistant row', async () => {
  const rows = job(10)
  const kept = cut(rows, 6)!
  expect(kept[0]).toEqual(rows[0])
  expect(kept[1].role).toBe('assistant')
  expect(kept.length).toBe(7)
  expect(kept.at(-1)).toEqual(rows.at(-1))
})

test('moves the tail forward when the cut would land on a tool result', async () => {
  const rows = job(10)
  expect(rows[tailStart(rows, 5)].role).toBe('assistant')
  expect(cut(rows, 5)!.length).toBe(5)
})

test('has nothing to cut in a short conversation', async () => {
  expect(cut(job(2), 6)).toBe(null)
  expect(cut([], 6)).toBe(null)
})

test('answers compaction itself, and skips when there is nothing to cut', async $ => {
  const answered = await $.session.compact({})
  expect(typeof answered.skip).toBe('string')
})
