import type { EngineInterface, Register } from 'claude-code'

// The same meter runs beside every contender, the shipped one included, so
// every figure in the results is taken the same way. It changes nothing.
const LOG = '.meter/log.jsonl'
const NL = String.fromCharCode(10)
const rows: string[] = []

async function note($: EngineInterface, row: Record<string, unknown>) {
  rows.push(JSON.stringify({ at: await $.clock.now(), ...row }))
  await $.fs.write(LOG, rows.join(NL) + NL)
}

type M = { text: string; toolUses: readonly { text?: string }[]; toolResults?: readonly { text: string }[] }

function size(m: M): number {
  return m.text.length + m.toolUses.reduce((n, u) => n + (u.text?.length ?? 0), 0)
    + (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0)
}

export const register: Register = on => {
  // one request to the model: what it read, what it wrote, what the cache served
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId) {
      await note($, { kind: 'step', index: e.index, messages: e.messageCount, usage: result.usage,
        stop: result.stopReason, tools: result.toolUses.length })
    }
    return result
  })

  // one compaction: the conversation before, and what stands after
  on('session.compact', async ($, e, next) => {
    const before = e.messages ?? []
    const result = await next(e)
    const after = result.messages
    await note($, { kind: 'compact', trigger: e.trigger, before: before.length,
      beforeChars: before.reduce((n, m) => n + size(m), 0),
      skip: result.skip, after: after?.length,
      afterChars: after?.reduce((n, m) => n + size(m), 0),
      tokensBefore: result.skip === undefined ? result.tokensBefore : undefined,
      tokensAfter: result.skip === undefined ? result.tokensAfter : undefined,
      usage: result.skip === undefined ? result.usage : undefined,
      afterText: after?.map(m => ({ role: m.role, kept: m.handle !== undefined, text: m.text.slice(0, 4000),
        toolUses: m.toolUses.length, toolResults: m.toolResults?.length ?? 0 })) })
    return result
  })

  // the context's fill after each turn, and the plan's limits
  on('session.measure', async ($, e, next) => {
    await note($, { kind: 'measure', context: e.context, rateLimits: e.rateLimits, cost: e.cost })
    return next(e)
  })
}
