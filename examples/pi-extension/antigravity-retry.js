// Load with Pi's -e option, using a provider named meridian-agy.
import { createHash, randomUUID } from 'node:crypto'
export default function (pi) {
  let pending
  const reset = () => { pending = undefined }
  // A new prompt or session operation is a new intent, even with identical text.
  for (const event of ['before_agent_start', 'session_start', 'session_shutdown', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact']) pi.on(event, reset)
  pi.on('turn_end', event => {
    if (event.message.stopReason === 'error' && pending) pending.retry = true
    else reset()
  })
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'meridian-agy') { reset(); return }
    const fingerprint = createHash('sha256').update(JSON.stringify(event.payload)).digest('hex')
    // Pi removes a failed assistant message before its agent-level retry.
    // Keep the ID only for that exact request; never cache conversation content.
    if (!pending?.retry || pending.fingerprint !== fingerprint) pending = { fingerprint, id: randomUUID(), retry: false }
    pending.retry = false
    return { ...event.payload, meridian_request_id: pending.id }
  })
}
