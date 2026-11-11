import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pending } from '../types'

/**
 * DecisionEngine for Claude Code.
 *
 * Every few turns, asks this session's own Claude (a fork of the
 * conversation, so it is read from the prompt cache and billed to the
 * developer's existing sign-in: no API key anywhere) which decisions were
 * settled, and records them as *proposed* on the team's DecisionEngine
 * service through the `de` CLI. Proposals show above the prompt with Accept
 * and Reject; nothing is enforced until someone accepts.
 *
 * All DecisionEngine logic (the extraction prompt, validation, credentials,
 * which project this repository is) lives in `de`; this module only decides
 * when to ask and shows what came back.
 */

/** Ask after this many completed turns since the last capture. */
const EVERY = 3

// Tagged so a later version that changes Pending's fields starts clean.
const pending = atom({ plugin: 'decisionengine', key: 'pending' } as const, [], { shape: 'pending-1' })

type Reply = {
  linked?: boolean
  error?: string
  prompt?: string
  server?: string
  proposals?: Pending[]
}

// Module state: reset on a reload, which also runs session.start again.
let linked = false
let sessionId = ''
let turns = 0
let isBusy = false

async function de($: EngineInterface, args: string[], stdin?: string): Promise<Reply> {
  const bin = ((await $.env.get('DE_PLUGIN_BIN')) || 'de').split(/\s+/)
  try {
    const r = await $.process.run([...bin, ...args], { stdin, timeoutMs: 60_000 })
    const line = r.stdout.trim().split('\n').at(-1)
    return line ? (JSON.parse(line) as Reply) : { error: r.stderr.trim() || `de exited ${r.exitCode}` }
  } catch (err) {
    return { error: String(err) }
  }
}

async function capture($: EngineInterface, manual: boolean): Promise<string> {
  if (isBusy) return 'DecisionEngine is already reading this conversation.'
  isBusy = true
  try {
    const asked = await de($, ['plugin-capture', 'prompt', '--session', sessionId])
    if (!asked.linked || !asked.prompt) return asked.error ?? 'This repository is not linked to DecisionEngine (run `de init --claude`).'
    const reply = await $.model.fork({ prompt: asked.prompt })
    if (!reply.isAnswered) return `DecisionEngine could not read the conversation (${reply.reason}).`
    const sent = await de($, ['plugin-capture', 'submit', '--session', sessionId], reply.text)
    if (sent.error) return `DecisionEngine: ${sent.error}`
    turns = 0
    const found = sent.proposals ?? []
    if (found.length) {
      await update($, pending, list => [...list.filter(p => !found.some(f => f.id === p.id)), ...found])
      $.ui.toast(`DecisionEngine: ${found.length} proposed decision${found.length === 1 ? '' : 's'} to review`)
    }
    return found.length
      ? `Proposed ${found.map(p => `${p.id} ${p.title}`).join('; ')}.`
      : manual
        ? 'No new settled decisions in this conversation.'
        : ''
  } finally {
    isBusy = false
  }
}

async function decide($: EngineInterface, p: Pending, verdict: 'accept' | 'reject' | 'later') {
  await update($, pending, list => list.filter(x => x.id !== p.id))
  if (verdict === 'later') return
  const r = await de($, ['decide-proposal', verdict, p.id])
  $.ui.toast(r.error ? `DecisionEngine: ${r.error}` : `${p.id} ${verdict === 'accept' ? 'accepted: shared with your team' : 'rejected'}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    // Claiming tells the CLI's Stop/SessionEnd hook path to leave this session to us.
    const r = await de($, ['plugin-capture', 'claim', '--session', sessionId])
    linked = r.linked === true
    if (linked) {
      await $.command.register({
        name: 'capture-decisions',
        description: 'Find decisions settled in this conversation and propose them to your team',
      })
    }
    return next(e)
  })

  on('command.run', { command: 'capture-decisions' }, async $ => ({ text: await capture($, true) }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!linked || e.agentId !== undefined || e.isAborted) return done
    turns += 1
    // Outside this dispatch, so the session is never held up waiting on the fork.
    if (turns >= EVERY && !isBusy) $.clock.after(500, () => void capture($, false))
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)
    const p = list[0]
    if (!p || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : ''
    const notes = [p.rules ? `${p.rules} rule${p.rules === 1 ? '' : 's'} on accept` : '', p.supersedes.length ? `replaces ${p.supersedes.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ')
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Decision captured</Text> {p.id}: {p.title}
          {more}
        </Text>
        {p.why ? <Text dimColor>{p.why}</Text> : null}
        {notes ? <Text dimColor>{notes}</Text> : null}
        <Box>
          <Button key="accept" label="Accept" onPress={() => decide($, p, 'accept')} />
          <Text> </Text>
          <Button key="reject" label="Reject" onPress={() => decide($, p, 'reject')} />
          <Text> </Text>
          <Button key="later" label="Review later" onPress={() => decide($, p, 'later')} />
        </Box>
      </Box>
    )
  })
}
