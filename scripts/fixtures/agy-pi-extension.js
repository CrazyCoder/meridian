// Loaded by the actual Pi extension loader in the opt-in live gate.
import { Type } from 'typebox'
import { appendFileSync } from 'node:fs'

export default function (pi) {
  const audit = event => appendFileSync(process.env.MERIDIAN_EXTENSION_AUDIT, JSON.stringify(event) + '\n')
  const receipt = process.env.MERIDIAN_EXTENSION_RECEIPT
  const result = text => ({ content: [{ type: 'text', text }], details: {} })
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'client_receipt') return
    audit({ event: 'requested', id: event.toolCallId })
    if (!await ctx.ui.confirm('Fixture approval', 'Allow the custom client tool?')) return { block: true, reason: 'CLIENT_DENIED' }
    event.input.label = 'CLIENT_PATCHED'
  })
  pi.registerTool({ name: 'client_receipt', label: 'Receipt', description: 'Return the private client receipt after user approval.', parameters: Type.Object({ label: Type.String() }),
    async execute(id, params) { audit({ event: 'executed', id, label: params.label }); return result(`${params.label}:${receipt}`) },
  })
  pi.registerTool({ name: 'client_question', label: 'Question', description: 'Ask the user to select a fixture answer.', parameters: Type.Object({}),
    async execute(id, params, signal, onUpdate, ctx) {
      const answer = await ctx.ui.select('Fixture question', ['FIRST', 'SECOND'])
      audit({ event: 'answered', answer })
      return result(answer ?? 'CLIENT_CANCELLED')
    },
  })
  pi.registerTool({ name: 'install_extra', label: 'Enable tool', description: 'Enable the late_receipt client tool during this turn.', parameters: Type.Object({}),
    async execute() {
      pi.registerTool({ name: 'late_receipt', label: 'Late receipt', description: 'Return the private receipt from the newly registered tool.', parameters: Type.Object({}),
        async execute(id) { audit({ event: 'late-executed', id }); return result(receipt) },
      })
      pi.setActiveTools(['client_receipt', 'client_question', 'install_extra', 'late_receipt'])
      audit({ event: 'registered' })
      return result('late_receipt is enabled for the next user turn. Do not call it in this turn.')
    },
  })
  pi.on('session_start', () => pi.setActiveTools(['client_receipt', 'client_question', 'install_extra']))
}
