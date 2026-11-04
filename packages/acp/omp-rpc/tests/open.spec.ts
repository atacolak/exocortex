import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  OMP_OPEN_PATH,
  createOmpSessionLock,
  normalizeDshSessionId,
  parseOmpOpenInput,
  resumeRefused,
  reuseOrCreateDshSession,
  serveOmpOpen,
  type OmpOpenDeps,
} from '../src/open.ts'
import { OmpResumeError, type OmpTranscriptMatch } from '../src/resume.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const match: OmpTranscriptMatch = {
  id: '01a0c88e-7521-7000-bb6a-67527d2b6806',
  path: '/home/sf/.omp/agent/sessions/--home--/2026-11-03T00-00-00-000Z_01a0c88e-7521-7000-bb6a-67527d2b6806.jsonl',
  file: '2026-11-03T00-00-00-000Z_01a0c88e-7521-7000-bb6a-67527d2b6806.jsonl',
  cwd: '/home/sf/workspace',
  profile: 'argon',
}

function request(body: unknown): Request {
  return new Request(`http://localhost${OMP_OPEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deps(overrides: Partial<OmpOpenDeps> = {}): OmpOpenDeps {
  return {
    resolveTranscript: async () => match,
    openAgent: async () => ({ agent: {} as never }),
    openTranscript: async () => ({ summary: 'resumed', hydrated: 7 }),
    ...overrides,
  }
}

describe('parseOmpOpenInput', () => {
  it('trims the transcript and optional fields', () => {
    expect(parseOmpOpenInput({ ompSession: ' 01a0c88e ', profile: ' lead ', sessionId: ' session-1 ' })).toEqual({
      ompSession: '01a0c88e',
      profile: 'lead',
      sessionId: 'session-1',
    })
  })

  it('requires a transcript and a JSON object', () => {
    expect(() => parseOmpOpenInput(null)).toThrow('A JSON object body is required.')
    expect(() => parseOmpOpenInput({})).toThrow('"ompSession" is required.')
    expect(() => parseOmpOpenInput({ ompSession: 'x', profile: 3 })).toThrow('"profile" must be a non-empty string')
  })

  it('canonicalizes a bare uuid session identity onto the session- prefix', () => {
    expect(parseOmpOpenInput({ ompSession: 'x', sessionId: '01A0C88E-7521-7000-BB6A-67527D2B6806' }))
      .toMatchObject({ sessionId: 'session-01a0c88e-7521-7000-bb6a-67527d2b6806' })
  })
})

describe('normalizeDshSessionId', () => {
  it('prefixes bare UUIDs and leaves canonical ids alone', () => {
    expect(normalizeDshSessionId('01a0c88e-7521-7000-bb6a-67527d2b6806'))
      .toBe('session-01a0c88e-7521-7000-bb6a-67527d2b6806')
    expect(normalizeDshSessionId('session-01a0c88e-7521-7000-bb6a-67527d2b6806'))
      .toBe('session-01a0c88e-7521-7000-bb6a-67527d2b6806')
    expect(normalizeDshSessionId('session-7')).toBe('session-7')
    expect(normalizeDshSessionId('01a0c88e-7521-7000-bb6a-67527d2b680')).toBe('01a0c88e-7521-7000-bb6a-67527d2b680')
  })
})

describe('one OMP session maps onto one harness session', () => {
  it('serializes operations that target the same OMP session', async () => {
    const lock = createOmpSessionLock()
    const events: string[] = []
    const record = async (name: string, ms: number): Promise<void> => {
      events.push(`${name}:enter`)
      await delay(ms)
      events.push(`${name}:exit`)
    }
    await Promise.all([
      lock(match.id, () => record('open', 5)),
      lock(match.id, () => record('adopt', 1)),
    ])
    expect(events).toEqual(['open:enter', 'open:exit', 'adopt:enter', 'adopt:exit'])
  })

  it('keeps distinct OMP sessions in flight together', async () => {
    const lock = createOmpSessionLock()
    const events: string[] = []
    const record = async (name: string): Promise<void> => {
      events.push(`${name}:enter`)
      await delay(1)
      events.push(`${name}:exit`)
    }
    await Promise.all([
      lock('omp-a', () => record('a')),
      lock('omp-b', () => record('b')),
    ])
    expect(events.slice(0, 2).sort()).toEqual(['a:enter', 'b:enter'])
  })

  it('lets a failed operation release the next one', async () => {
    const lock = createOmpSessionLock()
    await expect(lock(match.id, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(lock(match.id, async () => 'ok')).resolves.toBe('ok')
  })

  it('reuses a concurrently adopted session instead of creating a second one', async () => {
    const lock = createOmpSessionLock()
    const bindings = new Map<string, SessionId>()
    let created = 0
    const create = async (): Promise<SessionId> => {
      created += 1
      await delay(2)
      return SessionId(`session-${String(created)}`)
    }
    const open = async (): Promise<SessionId> => await lock(match.id, async () => {
      const target = await reuseOrCreateDshSession({
        ompSessionId: match.id,
        findBound: async () => bindings.get(match.id),
        create,
      })
      bindings.set(match.id, target.sessionId)
      return target.sessionId
    })

    const [fromOpen, fromAdoption] = await Promise.all([open(), open()])
    expect(created).toBe(1)
    expect(fromOpen).toBe(fromAdoption)
  })
})

describe('resumeRefused', () => {
  it('reports a cold-resume attach failure as a stable 409 refusal', () => {
    expect(resumeRefused(new Error('OMP ownership unknown'))).toMatchObject({
      name: 'OmpResumeError',
      code: 'omp/resume-refused',
      message: 'OMP ownership unknown',
      status: 409,
    })
  })

  it('passes a stable resume error through and stringifies non-errors', () => {
    const stable = new OmpResumeError('omp/session-busy', 'busy', 409)
    expect(resumeRefused(stable)).toBe(stable)
    expect(resumeRefused('attach exploded')).toMatchObject({
      code: 'omp/resume-refused',
      message: 'attach exploded',
      status: 409,
    })
  })

  it('maps the refusal through the open route instead of a generic 500', async () => {
    const response = await serveOmpOpen(request({ ompSession: match.id }), deps({
      openTranscript: async () => { throw resumeRefused(new Error('reserve refused')) },
    }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'omp/resume-refused', message: 'reserve refused' },
    })
  })
})

describe('serveOmpOpen', () => {
  it('opens a transcript in the transcript working directory and returns its identity', async () => {
    const seen: unknown[] = []
    const response = await serveOmpOpen(request({ ompSession: '01a0c88e' }), deps({
      async openAgent(input) {
        seen.push(input)
        return { agent: { id: 'session-1' } as never, agentPreset: 'omp:argon' }
      },
      async openTranscript(input) {
        seen.push(input.transcript.id)
        return { summary: 'resumed as argon', hydrated: 12 }
      },
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      sessionId: 'session-1',
      agentPreset: 'omp:argon',
      ompSession: {
        id: match.id,
        path: match.path,
        cwd: match.cwd,
        profile: match.profile,
      },
      hydrated: 12,
      summary: 'resumed as argon',
    })
    expect(seen).toEqual([
      { cwd: '/home/sf/workspace', profile: 'argon', ompSessionId: match.id },
      match.id,
    ])
  })

  it('serializes concurrent opens of the same transcript through the shared lock', async () => {
    const events: string[] = []
    let created = 0
    const lock = createOmpSessionLock()
    const serve = async (): Promise<Response> => await serveOmpOpen(request({ ompSession: match.id }), deps({
      serialize: lock,
      async openAgent(input) {
        events.push(`open:${input.ompSessionId}`)
        created += 1
        await delay(2)
        return { agent: { id: `session-${String(created)}` } as never }
      },
      async openTranscript(input) {
        events.push(`transcript:${input.agent.id}`)
        return { summary: 'resumed', hydrated: 0 }
      },
    }))

    const responses = await Promise.all([serve(), serve()])
    const ids = await Promise.all(responses.map(async response => (await response.json() as { sessionId: string }).sessionId))
    expect(created).toBe(2)
    expect(events).toEqual([
      'open:' + match.id,
      'transcript:session-1',
      'open:' + match.id,
      'transcript:session-2',
    ])
    expect(ids).toEqual(['session-1', 'session-2'])
  })

  it('reports an unknown transcript as 404', async () => {
    const response = await serveOmpOpen(request({ ompSession: 'missing' }), deps({
      resolveTranscript: async () => { throw new Error('no OMP transcript matches "missing"') },
    }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'omp/transcript-not-found', message: 'no OMP transcript matches "missing"' },
    })
  })

  it('passes a stable session failure through with its status', async () => {
    const response = await serveOmpOpen(request({ ompSession: match.id, sessionId: 'session-9' }), deps({
      openAgent: async () => { throw new OmpResumeError('session/not-found', 'no such session', 404) },
    }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'session/not-found', message: 'no such session' },
    })
  })

  it('hides an unexpected failure behind the generic error and reports it', async () => {
    const errors: unknown[] = []
    const response = await serveOmpOpen(request({ ompSession: match.id }), deps({
      openTranscript: async () => { throw new Error('attach exploded') },
      logError: error => { errors.push(error) },
    }))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'gateway/internal', message: 'Internal error.' },
    })
    expect(errors).toHaveLength(1)
  })

  it('requires a body', async () => {
    const response = await serveOmpOpen(new Request(`http://localhost${OMP_OPEN_PATH}`, { method: 'POST' }), deps())
    expect(response.status).toBe(400)
  })
})
