import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__gpt-advisor__gpt_advisor'
const FAKE_KEY = 'sk-proj-' + 'A'.repeat(40)
const FAKE_GH = 'ghp_' + 'b'.repeat(36)
const ON = { options: { enabled: true } }

type Spawned = { argv: readonly string[]; input?: string }
type Msg = { role: 'user' | 'assistant'; content: { type: string; [field: string]: unknown }[] }
type Exit = { code: number | null; signal: string | null }
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }
const START = { cwd: '/', surface: 'terminal' as const, isInteractive: true }

// Stands in for the engine: messages, tools and the Codex child.
const world = (on: On, messages: Msg[], exit: Exit = { code: 0, signal: null }, advice = 'Check the tests first.') => {
  const spawned: Spawned[] = []
  on('session.messages', () => ({ value: messages }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs shell commands.', mcp: false }] }))
  on('process.spawn', async function* (_$, e) {
    spawned.push(e)
    yield { stream: 'stderr' as const, text: 'last line of codex log\n' }
    if (advice !== '') yield { stream: 'stdout' as const, text: advice + '\n' }
    return { value: exit }
  })
  return spawned
}

const CHAT: Msg[] = [
  { role: 'user', content: [{ type: 'text', text: 'Fix the login bug. My key is ' + FAKE_KEY }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'SECRET-THOUGHTS', signature: 'x' },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/src/login.ts' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'token = ' + FAKE_GH }, { type: 'image', source: {} }] },
    ],
  },
]

test('renders the transcript, forwards the system prompt and masks secrets', ON, async ($, on) => {
  const spawned = world(on, CHAT)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'SYSTEM-PROMPT-TEXT', scope: 'shared' as const }] }))
  await $.prompt.compose(COMPOSE)

  const ran = await $.tool.call({ tool: TOOL })
  expect(ran.result).toBe('Check the tests first.')

  const call = spawned[0]
  expect(call?.argv).toContain('gpt-6-astra')
  expect(call?.argv).toContain('model_reasoning_effort=max')
  const prompt = call?.input ?? ''
  expect(prompt).toContain('You are the advisor to an AI coding agent')
  expect(prompt).toContain('SYSTEM-PROMPT-TEXT')
  expect(prompt).toContain('- Bash: Runs shell commands.')
  expect(prompt).toContain('## user\nFix the login bug.')
  expect(prompt).toContain('[tool_use Read] {"file_path":"/src/login.ts"}')
  expect(prompt).toContain('[tool_result]\ntoken = [REDACTED]')
  expect(prompt).toContain('Give your advice now.')
  expect(prompt).not.toContain('SECRET-THOUGHTS')
  expect(prompt).not.toContain(FAKE_KEY)
  expect(prompt).not.toContain(FAKE_GH)
})

test('masks the other secret kinds', ON, async ($, on) => {
  const secrets = [
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'xoxb-' + '1234567890-abcdef',
    'Bearer ' + 'abcdefghijklmnopqrstuvwxyz',
    'eyJ' + 'hbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ]
  const spawned = world(on, [{ role: 'user', content: [{ type: 'text', text: secrets.join('\n') }] }])
  await $.tool.call({ tool: TOOL })
  const prompt = spawned[0]?.input ?? ''
  for (const s of secrets) expect(prompt).not.toContain(s)
})

test('drops the oldest middle messages over the cap, with a marker', ON, async ($, on) => {
  const big = (n: number): Msg => ({ role: 'user', content: [{ type: 'text', text: 'MSG' + n + ' ' + 'x'.repeat(200_000) }] })
  const spawned = world(on, [0, 1, 2, 3, 4].map(big))
  await $.tool.call({ tool: TOOL })
  const prompt = spawned[0]?.input ?? ''
  expect(prompt).toContain('MSG0 ')
  expect(prompt).toContain('[3 earlier messages omitted]')
  expect(prompt).not.toContain('MSG2 ')
  expect(prompt).toContain('MSG4 ')
  expect(prompt.length).toBeLessThan(610_000)
})

test('a failed Codex run comes back as result text', ON, async ($, on) => {
  world(on, CHAT, { code: 1, signal: null }, '')
  const ran = await $.tool.call({ tool: TOOL })
  expect(ran.isError).toBeUndefined()
  expect(ran.result).toBe('GPT advisor unavailable: codex exited with code 1 and no advice (last line of codex log)')
})

test('a timeout comes back as result text', ON, async ($, on) => {
  world(on, CHAT, { code: 124, signal: null }, '')
  const ran = await $.tool.call({ tool: TOOL })
  expect(ran.result).toBe('GPT advisor unavailable: timed out after 20 minutes')
})

test('a spawn that cannot start comes back as result text', ON, async ($, on) => {
  on('session.messages', () => ({ value: CHAT }))
  on('tool.list', () => ({ value: [] }))
  on('process.spawn', async function* () {
    throw new Error('codex: not found')
  })
  const ran = await $.tool.call({ tool: TOOL })
  expect(String(ran.result)).toMatch(/^GPT advisor unavailable: /)
})

test('the model comes from userConfig', { options: { enabled: true, model: 'gpt-6.1-sol' } }, async ($, on) => {
  const spawned = world(on, CHAT)
  await $.tool.call({ tool: TOOL })
  expect(spawned[0]?.argv).toContain('gpt-6.1-sol')
})

test('the command shows the values and sets them through /config', async ($, on) => {
  const sets: { key: string; value: unknown }[] = []
  on('config.set', (_$, e) =>
    e.value === 'gpt-4' ? { deny: 'not an option' } : (sets.push({ key: e.key, value: e.value }), { value: e.value }))

  const shown = await $.command.run({ command: 'gpt-advisor', args: '', ...RUN })
  expect(shown.text).toContain('Enabled: false')
  expect(shown.text).toContain('Mode: alongside')
  expect(shown.text).toContain('Model: gpt-6-astra')

  const setModel = await $.command.run({ command: 'gpt-advisor', args: 'model gpt-6.1-sol', ...RUN })
  expect(setModel.text).toContain('Model: gpt-6.1-sol')
  const setMode = await $.command.run({ command: 'gpt-advisor', args: 'mode replace', ...RUN })
  expect(setMode.text).toContain('Mode: replace')
  expect(sets).toEqual([
    { key: 'gpt-advisor.model', value: 'gpt-6.1-sol' },
    { key: 'gpt-advisor.mode', value: 'replace' },
  ])

  const bad = await $.command.run({ command: 'gpt-advisor', args: 'model gpt-4', ...RUN })
  expect(bad.text).toContain('Not changed: not an option')
  const usage = await $.command.run({ command: 'gpt-advisor', args: 'color red', ...RUN })
  expect(usage.text).toContain('Usage:')
})

const startWorld = (on: On, native: { value: string | undefined }) => {
  const toasts: string[] = []
  const logs: string[] = []
  const tools: string[] = []
  on('tool.register', (_$, e) => (tools.push(e.name), { value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'gpt-advisor' } }))
  on('settings.read', () => ({ value: native.value === undefined ? {} : { advisorModel: native.value } }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.log', (_$, e) => (logs.push(e.text), { value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.section', (_$, e) => ({ text: e.text }))
  return { toasts, logs, tools }
}

test('disabled: no tool, no guidance, no warning', { options: { mode: 'replace' } }, async ($, on) => {
  const { toasts, tools } = startWorld(on, { value: 'fable' })
  await $.session.start(START)
  expect(tools).toEqual([])
  expect(toasts).toEqual([])
  const section = await $.prompt.section({ name: 'env_info_simple', text: 'ENV' })
  expect(section.text).toBe('ENV')
})
test('enabled: the tool, and the guidance sent to the running thread', ON, async ($, on) => {
  const { toasts, tools } = startWorld(on, { value: 'fable' })
  await $.session.start(START)
  expect(tools).toEqual(['gpt_advisor'])
  expect(toasts).toEqual([])
  const section = await $.prompt.section({ name: 'env_info_simple', text: 'ENV' })
  expect(section.text).toContain('ENV\n\n# GPT Advisor Tool')
  expect(section.text).toContain('The native advisor tool is also available.')
  expect(section.breakPromptCache).toBe(true)
})

test('alongside: no mention of a native advisor that is off', ON, async ($, on) => {
  startWorld(on, { value: undefined })
  await $.session.start(START)
  const section = await $.prompt.section({ name: 'env_info_simple', text: 'ENV' })
  expect(section.text).toContain('# GPT Advisor Tool')
  expect(section.text).not.toContain('The native advisor tool is also available.')
})

test('replace mode warns at session start only while the native advisor is on', { options: { enabled: true, mode: 'replace' } }, async ($, on) => {
  const native = { value: 'fable' as string | undefined }
  const { toasts, logs } = startWorld(on, native)
  await $.session.start(START)
  expect(toasts[0]).toContain('Turn it off with /advisor')
  expect(logs[0]).toContain('Turn it off with /advisor')
  native.value = undefined
  await $.session.start(START)
  expect(toasts.length).toBe(1)
})

const ROW = { tool_use_id: 't9', tool: TOOL, input: {}, isRunning: false, isErrored: false, isInterrupted: false }

test('the tool row reads like the native advisor row', { options: { enabled: true, model: 'gpt-6.1-terra' } }, async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'gpt-advisor', surface, component: 'ToolUse', requestId: 't9', props: ROW })
    expect((await ui.find({ type: 'Text', text: /using GPT 6\.1 Terra/ }))?.text).toBe(' using GPT 6.1 Terra')
    expect(await ui.find({ type: 'Text', text: /Advising/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gpt_advisor/ })).toBeUndefined()
    await ui.unmount()

    const done = await $.ui.mount({ plugin: 'gpt-advisor', surface, component: 'ToolResult', requestId: 't9', props: { tool_use_id: 't9', tool: TOOL, output: 'Long advice.', isErrored: false } })
    expect((await done.find({ type: 'Text', text: /reviewed/ }))?.text).toContain('Advisor has reviewed the conversation')
    await done.unmount()

    const failed = await $.ui.mount({ plugin: 'gpt-advisor', surface, component: 'ToolResult', requestId: 't9', props: { tool_use_id: 't9', tool: TOOL, output: 'GPT advisor unavailable: timed out after 20 minutes', isErrored: false } })
    expect((await failed.find({ type: 'Text', text: /unavailable/ }))?.text).toContain('timed out')
    await failed.unmount()
  }
})

test('the detailed transcript shows the advice itself', ON, async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ plugin: 'gpt-advisor', surface: 'terminal', component: 'ToolResult', requestId: 't9', props: { tool_use_id: 't9', tool: TOOL, output: 'Long advice.', isErrored: false, isExpanded: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
