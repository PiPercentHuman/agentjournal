import { test, expect } from 'claude-code/testing'
import {
  entry, fold, HOW, MAX_CLEARS, older, pinUpdates, sleepEntry, summarise, tailStart, topicDone, wakeText, withUpdates,
} from './journal'

const u = (n: number) => ({ role: 'user' as const, n })
const a = (n: number) => ({ role: 'assistant' as const, n })
const job = (pairs: number) => [u(0), ...Array.from({ length: pairs }, (_, k) => [a(2 * k + 1), u(2 * k + 2)]).flat()]

test('a journal line is the action, never what came back', async () => {
  expect(entry(7, 'Bash', { command: 'echo "n04.txt zelnequa" >> answers.txt', description: 'x' }, false))
    .toBe('7. Bash echo "n04.txt zelnequa" >> answers.txt')
  expect(entry(8, 'Read', { file_path: 'notes/n05.txt' }, true)).toBe('8. Read notes/n05.txt - FAILED')
  expect(summarise({ odd: 1 })).toBe('{"odd":1}')
})

test('the kept steps start on an assistant row', async () => {
  const rows = job(10)
  expect(rows[tailStart(rows, 5)].role).toBe('assistant')
  expect(fold(rows, 6)!.tail.length).toBe(6)
  expect(fold(job(2), 6)).toBe(null)
})

test('the wake-up carries the pins word for word and every journal line', async () => {
  const text = wakeText(['Write keys in UPPERCASE if URGENT.'], ['1. Read notes/n01.txt', '2. Bash echo x'])
  expect(text.includes('Write keys in UPPERCASE if URGENT.')).toBe(true)
  expect(text.includes('2. Bash echo x')).toBe(true)
})

test('a topic ends on its own line, and only there', async () => {
  expect(topicDone('Wrote a.txt.\nTOPIC DONE: secret word is kestrel, a.txt written')).toBe('secret word is kestrel, a.txt written')
  expect(topicDone('I will say TOPIC DONE: later, not yet.')).toBe(null)
  expect(topicDone('All good.')).toBe(null)
  expect(topicDone('TOPIC DONE: first\nmore work\nTOPIC DONE: second')).toBe('second')
})

test('a rewritten instruction is filed under the pin it changes', async () => {
  expect(pinUpdates('ok\nPIN UPDATE 1: End with the line DONE 4T-HERON.', 3))
    .toEqual([{ pin: 1, by: 3, text: 'End with the line DONE 4T-HERON.' }])
  expect(pinUpdates('PIN UPDATE 5: a pin that does not exist yet', 3)).toEqual([])
  const pins = withUpdates(['End with DONE.', 'Use B.'], [{ pin: 1, by: 2, text: 'End with DONE 4T-HERON.' }])
  expect(pins[0]).toBe('End with DONE.\n#### 1.1 updated by pin 2 (how this part stands now; it replaces that part of pin 1)\nEnd with DONE 4T-HERON.')
  expect(pins[1]).toBe('Use B.')
})

test('after a clear the wake-up holds every pin, every update and every journal line, and how to end a topic', async () => {
  const pins = withUpdates(['Read the notes.', 'Use capitals.'], [{ pin: 1, by: 2, text: 'Read only the urgent notes.' }])
  const text = wakeText(pins, ['1. Bash cat secret.txt', sleepEntry(2, 'the word is kestrel')], 'clear')
  for (const s of ['Read the notes.', 'Use capitals.', 'Read only the urgent notes.', '1. Bash cat secret.txt',
    '2. SLEEP the word is kestrel', 'your context was cleared', 'TOPIC DONE:', 'PIN UPDATE'])
    expect(text.includes(s)).toBe(true)
  expect(text.includes('they follow below')).toBe(false)
  expect(MAX_CLEARS).toBe(20)
  expect(HOW.includes('TOPIC DONE:')).toBe(true)
})

test('it answers compaction itself, and skips when there is nothing to fold', async $ => {
  const answered = await $.session.compact({})
  expect(typeof answered.skip).toBe('string')
})

test('the journal stops where the kept steps start', async () => {
  const tail = [{ role: 'assistant' as const, toolUses: [1] }, { role: 'user' as const },
    { role: 'assistant' as const, toolUses: [1, 2] }, { role: 'user' as const }]
  expect(older(['1. a', '2. b', '3. c', '4. d', '5. e'], tail)).toEqual(['1. a', '2. b'])
  expect(older(['1. a'], tail)).toEqual([])
})
