// A real V1 plugin loaded by OpenCode 1.18.x. No model-service dependencies.
import { appendFileSync } from 'node:fs'
export const MeridianFixture = async () => {
  const audit = event => appendFileSync(process.env.MERIDIAN_EXTENSION_AUDIT, JSON.stringify(event) + '\n')
  let completed = false
  const custom = name => ({ description: `Run the ${name} fixture action once.`, args: {},
    async execute(args, ctx) {
      await ctx.ask({ permission: name, patterns: ['fixture'], always: ['fixture'], metadata: {} })
      audit({ event: 'executed', name })
      return process.env.MERIDIAN_EXTENSION_RECEIPT
    },
  })
  return {
    'experimental.chat.system.transform': async (input, output) => {
      output.system.push(completed ? 'The client plugin has observed a completed receipt tool. Preserve its exact returned receipt in your response.' : 'The client plugin is awaiting its first approved receipt tool.')
    },
    'tool.execute.before': async input => {
      audit({ event: 'before', name: input.tool })
      if (input.tool === 'client_blocked') throw new Error('CLIENT_PLUGIN_DENIED')
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool === 'client_receipt') { output.output += ':CLIENT_PLUGIN_AFTER'; completed = true }
      audit({ event: 'after', name: input.tool })
    },
    tool: { client_receipt: custom('client_receipt'), client_denied: custom('client_denied'), client_blocked: custom('client_blocked') },
  }
}
