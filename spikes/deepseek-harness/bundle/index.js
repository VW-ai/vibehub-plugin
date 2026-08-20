/** Disposable host-plane proof for the VibeHub DSH feasibility Ticket. */

export const name = 'vibehub-foundation-spike'
export const inject = ['commands']

export function apply(ctx) {
  ctx.commands.register({
    name: 'vibehub-demo',
    description: 'Append one durable VibeHub demo Run event without a model turn.',
    recordInput: false,
    handler: ({ agent }) => {
      const event = agent.session.append('vibehub/run', {
        ticketId: 'ticket-demo',
        phase: 'queued',
        source: 'explicit-command',
      }, { ignorable: true })
      return {
        kind: 'success',
        text: 'VibeHub demo Run event appended.',
        sourceEventSeq: event.seq,
      }
    },
  })
  ctx.commands.register({
    name: 'vibehub-client-fixture',
    description: 'Append one clearly labelled assistant fixture for client-slot validation.',
    recordInput: false,
    handler: ({ agent }) => {
      const turn = agent.session.events.reduce((latest, event) =>
        event.type === 'turn/start' ? Math.max(latest, event.data.turn) : latest, 0) + 1
      agent.session.append('turn/start', { turn })
      agent.session.append('step/start', { turn, step: 1 })
      const event = agent.session.append('assistant/message', {
        turn,
        step: 1,
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: 'UI fixture: fork this assistant message to validate the VibeHub action slot.' }],
          source: { kind: 'model', provider: 'vibehub-spike', model: 'fixture' },
        },
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return {
        kind: 'success',
        text: 'VibeHub client fixture appended.',
        sourceEventSeq: event.seq,
      }
    },
  })
  ctx.logger.info('registered /vibehub-demo without modifying the agent loop')
}
