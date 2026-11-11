import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'decisionengine',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const USAGE = { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }

const REPLY =
  '```json\n{"decisions":[{"title":"Sessions over JWTs","why":"Revocation must be instant."}]}\n```'

/** Stands in for the `de` CLI: answers each subcommand and records every call. */
function fakeDe(calls: { argv: readonly string[]; stdin?: string }[], linked = true) {
  return (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const [, command, action] = e.argv
    const out =
      !linked ? { linked: false }
      : action === 'claim' ? { linked: true, project: 'web' }
      : action === 'prompt' ? { linked: true, prompt: 'Which decisions were settled?' }
      : action === 'submit' ? { linked: true, proposals: [{ id: 'DEC-012', title: 'Sessions over JWTs', why: 'Revocation must be instant.', rules: 1, supersedes: [] }] }
      : command === 'decide-proposal' ? { id: e.argv[3], status: 'accepted' }
      : { error: 'unexpected' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
}

test('captures with a fork of the session, proposes, and accepts from the band', async ($, on) => {
  const calls: { argv: readonly string[]; stdin?: string }[] = []
  const forks: string[] = []
  const toasts: string[] = []
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', fakeDe(calls))
  on('command.register', () => ({ value: { command: 'capture-decisions' } }))
  on('model.fork', (_, e) => (forks.push(e.prompt), { value: { isAnswered: true, text: REPLY, usage: USAGE } }))
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(calls[0]?.argv).toEqual(['de', 'plugin-capture', 'claim', '--session', 'sess-1'])

  const ran = await $.command.run({ command: 'capture-decisions', args: '' } as never)
  expect(ran).toMatchObject({ text: 'Proposed DEC-012 Sessions over JWTs.' })
  expect(forks).toEqual(['Which decisions were settled?'])
  expect(calls.find(c => c.argv[2] === 'submit')?.stdin).toBe(REPLY)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /DEC-012/ }))?.text).toContain('Sessions over JWTs')
    expect(await ui.find({ type: 'Text', text: /1 rule on accept/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'accept' })
  await ui.unmount()
  expect(calls.at(-1)?.argv).toEqual(['de', 'decide-proposal', 'accept', 'DEC-012'])

  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /DEC-012/ })).toBeUndefined()
  await after.unmount()
})

test('stays out of the way in a repository that is not linked', async ($, on) => {
  const calls: { argv: readonly string[]; stdin?: string }[] = []
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-2' }))
  on('process.run', fakeDe(calls, false))
  on('command.register', () => ({ value: { command: 'capture-decisions' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  expect(calls).toHaveLength(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /captured/ })).toBeUndefined()
  await ui.unmount()
})

test('asks every few main-thread turns, in the background, never for subagents', async ($, on) => {
  const calls: { argv: readonly string[]; stdin?: string }[] = []
  let forks = 0
  const clock = mock.clock(on)
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-3' }))
  on('process.run', fakeDe(calls))
  on('command.register', () => ({ value: { command: 'capture-decisions' } }))
  on('model.fork', () => (forks++, { value: { isAnswered: true, text: REPLY, usage: USAGE } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const turn = (agentId?: string) =>
    $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: String(Math.random()), ...(agentId ? { agentId } : {}) } as never)

  await turn()
  await turn('sub-1')
  await turn()
  await clock.advance(1000)
  expect(forks).toBe(0)
  await turn()
  expect(forks).toBe(0)
  await clock.advance(1000)
  expect(forks).toBe(1)
  expect(calls.filter(c => c.argv[2] === 'submit')).toHaveLength(1)
})
