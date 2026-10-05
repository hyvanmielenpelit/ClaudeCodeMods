import { expect, mock, test } from 'claude-code/testing'

import { CHECK_LABEL, CHECK_PROMPT, waitingReport } from '../hooks/probe'

test('a subscription with no check in flight is offered the check message', () => {
  expect(waitingReport('/usage-dollars', '00000000-0000-4000-8000-000000000001', false)).toEqual({
    type: 'waiting',
    command: '/usage-dollars',
    canSend: true,
  })
})

test('no second check is offered while one is in flight', () => {
  expect(waitingReport('/usage-dollars calibrate', '00000000-0000-4000-8000-000000000001', true).canSend).toBe(false)
})

test('a sign-in without a subscription is told there is nothing to wait for, and offered no check', () => {
  expect(waitingReport('/usage-dollars', 'none', false)).toEqual({ type: 'waiting', command: '/usage-dollars', canSend: false, isUnsubscribed: true })
})

test('the check message describes itself, asks for a one-word reply and no tools, and the label states its cost', () => {
  expect(CHECK_PROMPT.startsWith('usage-dollars check:')).toBe(true)
  expect(CHECK_PROMPT).toContain('Reply with the single word OK.')
  expect(CHECK_PROMPT).toContain('Do not use any tools.')
  expect(CHECK_LABEL).toContain('uses one turn')
})

const ORG = '00000000-0000-4000-8000-000000000001'

for (const surface of ['terminal', 'desktop'] as const)
  test(`the first-reading card's button sends the check message once (${surface})`, async ($, on) => {
    const submitted: string[] = []
    on('session.usage', async () => ({ value: { rateLimits: [], context: {} } }) as never)
    on('session.id', async () => ({ value: 'session-1' }))
    on('process.run', async () => ({ value: { stdout: JSON.stringify({ org: ORG, orgSource: 'profile', profile: null, labels: {} }), stderr: '', exitCode: 0 } }) as never)
    mock.store(on)
    mock.clock(on, { now: Date.parse('2026-10-05T10:00:00.000Z') })
    on('ui.log', async () => ({ value: undefined }))
    on('ui.status', async () => ({ value: undefined }))
    on('prompt.submit', async (_, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    const run = await $.command.run({ command: 'usage-dollars', args: '' } as never)
    const text = (run as { text: string }).text
    expect(text).toContain('### Waiting for the first usage reading')
    const ui = await $.ui.mount({
      plugin: 'usage-dollars',
      surface,
      component: 'CommandOutput',
      props: { command: 'usage-dollars', args: '', text, isErrored: false } as never,
    })
    expect((await ui.find({ key: 'send-check' }))?.props.label).toBe(CHECK_LABEL)
    await ui.press({ key: 'send-check' })
    expect(submitted).toEqual([CHECK_PROMPT])
    expect(await ui.find({ key: 'send-check' })).toBeUndefined()
    expect((await ui.find({ text: 'A check message was sent.' })) !== undefined).toBe(true)
  })
