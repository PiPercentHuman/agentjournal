import type { Register } from 'claude-code'
import { cut } from './cut'

export const register: Register = on => {
  // Claude Code is about to compact. Answer in its place: no summary is
  // written and no model is called.
  on('session.compact', async ($, e) => {
    const kept = cut(e.messages ?? [])
    if (kept === null) return { skip: `${$.plugin.name}: nothing to cut yet` }
    return { messages: kept }
  }).catch(($, e, next) => next(e)) // if the cut fails, Claude Code compacts as usual
}
