import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

describe('Session.append timing', () => {
  it('records an explicit hydration time on structural and surface events', () => {
    const session = Session.create(SessionId('append-time'))
    const recorded = Date.parse('2026-10-25T08:26:39.017Z')

    const start = session.append('turn/start', { turn: 1 }, { time: recorded })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }), { surfaceOp: 'append', time: recorded + 5 })

    expect(start.time).toBe(recorded)
    expect(message.time).toBe(recorded + 5)
    expect(session.snapshotEvents().map(event => event.time)).toEqual([recorded, recorded + 5])
  })

  it('rejects a non-integer or negative explicit time', () => {
    const session = Session.create(SessionId('append-time-invalid'))

    expect(() => session.append('turn/start', { turn: 1 }, { time: -1 }))
      .toThrow('session event time must be a non-negative safe integer')
    expect(() => session.append('turn/start', { turn: 1 }, { time: 1.5 }))
      .toThrow('session event time must be a non-negative safe integer')
    expect(session.snapshotEvents()).toHaveLength(0)
  })
})
