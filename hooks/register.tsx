import type { EngineInterface, Register } from 'claude-code'

const TOOL = 'mcp__gpt-advisor__gpt_advisor'
const MODELS: readonly [string, ...string[]] = ['gpt-6-astra', 'gpt-6.1-terra', 'gpt-6.1-sol']
const MODES: readonly [string, ...string[]] = ['alongside', 'replace']
const NAMES: Readonly<Record<string, string>> = {
  'gpt-6-astra': 'GPT 6 Astra',
  'gpt-6.1-terra': 'GPT 6.1 Terra',
  'gpt-6.1-sol': 'GPT 6.1 Sol',
}
// The Codex model cache lists gpt-6-astra at 272k tokens and gpt-6.1-sol at
// 500k (gpt-6.1-terra is not listed). 600k chars is about 170k tokens, which
// fits astra's window with room for Codex's own prompt and max reasoning.
const MAX_CHARS = 600_000
const TIMEOUT_SECONDS = 20 * 60
const SEP = '\n\n'
const UNAVAILABLE = 'GPT advisor unavailable: '
const REVIEWED = '✔ Advisor has reviewed the conversation and will apply the feedback'
// The guidance rides on this engine section, so a reload can send it to the running thread.
const ANCHOR_SECTION = 'env_info_simple'

const GUIDANCE = [
  '# GPT Advisor Tool',
  "You have access to a gpt_advisor tool backed by a stronger reviewer model (OpenAI GPT). It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.",
  "Call it BEFORE substantive work -- before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call it. Orientation is not substantive work. Writing, editing, and declaring an answer are.",
  'Also call it:',
  "- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The call takes minutes; if the session ends during it, a durable result persists and an unwritten one doesn't.",
  "- When stuck -- errors recurring, approach not converging, results that don't fit.",
  '- When considering a change of approach.',
  "On tasks longer than a few steps, call it at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling.",
  'Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt. A passing self-test is not evidence the advice is wrong.',
  "If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more call.",
].join('\n')

// In alongside mode Claude otherwise prefers the native advisor and skips this one.
const ALONGSIDE =
  'The native advisor tool is also available. Each time you call advisor, call gpt_advisor right after it returns, as a separate call. Never call them in parallel.'

const DESCRIPTION =
  'Consult a stronger reviewer (OpenAI GPT) who sees your full conversation transcript. ' +
  'No parameters: your whole history (task, every tool call and result) is forwarded automatically. ' +
  'Call it before substantive work, when stuck, when changing approach, and before declaring done. The call takes minutes.'

const ADVISOR_INSTRUCTIONS = [
  'You are the advisor to an AI coding agent (the executor). Below is the transcript of its session: its system prompt, its tools, and every message, tool call and tool result so far.',
  'Give concise, specific, actionable advice, 400-700 words at most:',
  '- Flag wrong assumptions, risks and mistakes.',
  '- Recommend the next step, and say why.',
  '- If the work looks done, say what to verify before declaring it done.',
  'You cannot run tools or read files. Answer from the transcript only.',
].join('\n')

const WARNING =
  'gpt-advisor is in replace mode, but the native advisor is on. Turn it off with /advisor.'

const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

type Block = { type: string; [field: string]: unknown }
type Message = { role: string; content: readonly Block[] }
type Settings = { isEnabled: boolean; model: string; mode: string }

let systemPrompt = ''

const mask = (text: string): string =>
  SECRETS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), text)

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(b => b?.type === 'text').map(b => String(b.text)).join('\n')
      : ''

// Thinking, redacted thinking, images and documents render as nothing.
const renderBlock = (b: Block): string =>
  b.type === 'text' ? String(b.text)
  : b.type === 'tool_use' ? '[tool_use ' + String(b.name) + '] ' + JSON.stringify(b.input)
  : b.type === 'tool_result' ? '[tool_result' + (b.is_error ? ' error' : '') + ']\n' + resultText(b.content)
  : ''

const renderMessage = (m: Message): string => {
  const body = m.content.map(renderBlock).filter(s => s !== '').join('\n')
  return body === '' ? '' : '## ' + m.role + '\n' + body
}

// Keeps the head, the first message and the newest messages that fit;
// drops from the oldest middle.
const fit = (head: string, messages: readonly string[]): string => {
  const all = [head, ...messages].join(SEP)
  if (all.length <= MAX_CHARS || messages.length < 2) return all
  const first = messages[0] ?? ''
  const rest = messages.slice(1)
  const budget = MAX_CHARS - head.length - first.length - 200
  const kept = rest.reduceRight(
    (acc, m) =>
      acc.isFull || acc.used + m.length + SEP.length > budget
        ? { ...acc, isFull: true }
        : { used: acc.used + m.length + SEP.length, list: [m, ...acc.list], isFull: false },
    { used: 0, list: [] as string[], isFull: false },
  ).list
  const marker = '[' + (rest.length - kept.length) + ' earlier messages omitted]'
  return [head, first, marker, ...kept].join(SEP)
}

const buildPrompt = async ($: EngineInterface, agentId: string | undefined): Promise<string> => {
  const read = agentId === undefined
    ? await $.session.messages({ as: 'api' })
    : await $.session.messages({ as: 'api', agentId })
  if (!Array.isArray(read)) throw new Error(read.deny)
  const tools = (await $.tool.list()).map(t => '- ' + t.name + ': ' + t.description).join('\n')
  const head = '# System prompt\n' + systemPrompt + SEP + '# Tools\n' + tools + SEP + '# Messages'
  const messages = read.map(renderMessage).filter(s => s !== '')
  return mask(ADVISOR_INSTRUCTIONS + SEP + '<transcript>\n' + fit(head, messages) + '\n</transcript>' + SEP + 'Give your advice now.')
}

const codexArgv = (model: string): string[] => [
  'timeout', '-k', '10', String(TIMEOUT_SECONDS),
  'codex', 'exec', '-m', model, '-c', 'model_reasoning_effort=max',
  '--ignore-user-config', '--ignore-rules',
  '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
  '--disable', 'multi_agent', '--disable', 'view_image', '--disable', 'code_mode_host',
  '--disable', 'unified_exec', '--disable', 'sleep_tool',
  '-c', 'web_search="disabled"', '-c', 'model_reasoning_summary="none"',
  '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
  '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-',
]

// Codex prints the final answer alone on stdout and its log on stderr.
const askCodex = async ($: EngineInterface, model: string, prompt: string): Promise<string> => {
  const stream = $.process.spawn({ argv: codexArgv(model), input: prompt })
  let advice = ''
  let log = ''
  for await (const chunk of stream) {
    if (chunk.stream === 'stdout') advice += chunk.text
    else log = (log + chunk.text).slice(-500)
  }
  const { code, signal } = await stream.result
  if (code === 124) return UNAVAILABLE + 'timed out after 20 minutes'
  if (code === 0 && advice.trim() !== '') return advice.trim()
  const why = log.trim().split('\n').at(-1) ?? ''
  return UNAVAILABLE + 'codex exited with ' + (signal ?? 'code ' + code) +
    (advice.trim() === '' ? ' and no advice' : '') + (why === '' ? '' : ' (' + mask(why) + ')')
}

const isNativeOn = async ($: EngineInterface): Promise<boolean> => {
  const native = await $.settings.read({ key: 'advisorModel' })
  return typeof native === 'string' && native !== ''
}

const warnIfNativeOn = async ($: EngineInterface): Promise<void> => {
  if (await isNativeOn($)) {
    $.ui.toast(WARNING)
    $.ui.log(WARNING)
  }
}

const describe = (s: Settings): string =>
  'Enabled: ' + s.isEnabled + ' (turn on or off in /config)\n' +
  'Mode: ' + s.mode + ' (choices: ' + MODES.join(', ') + ')\n' +
  'Model: ' + s.model + ' (choices: ' + MODELS.join(', ') + ')'

// The settings are userConfig fields (/config); a change reloads the module.
export const register: Register = (on, options) => {
  const settings: Settings = {
    isEnabled: options.enabled === true,
    model: String(options.model),
    mode: String(options.mode),
  }
  let isDotOn = true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gpt-advisor',
      description: 'Show or set the GPT advisor model and mode.',
      argumentHint: '[model <name> | mode alongside|replace]',
    })
    if (settings.isEnabled) {
      await $.tool.register({
        name: 'gpt_advisor',
        description: DESCRIPTION,
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
      if (settings.mode === 'replace') await warnIfNativeOn($)
    }
    return next(e)
  })

  on('prompt.section', { name: ANCHOR_SECTION }, async ($, e, next) => {
    const core = await next(e)
    if (!settings.isEnabled) return { ...core, breakPromptCache: true }
    const isBoth = settings.mode === 'alongside' && (await isNativeOn($))
    return {
      text: (core.text === null ? '' : core.text + SEP) + GUIDANCE + (isBoth ? '\n' + ALONGSIDE : ''),
      breakPromptCache: true,
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    systemPrompt = composed.sections.map(s => s.text).join(SEP)
    return composed
  })

  if (settings.isEnabled) {
    on('tool.call', { tool: TOOL }, async ($, e) => {
      const blink = $.clock.every(500, () => {
        isDotOn = !isDotOn
        $.ui.invalidate('ui.render')
      })
      try {
        const prompt = await buildPrompt($, e.agentId)
        return { result: await askCodex($, settings.model, prompt) }
      } catch (err) {
        return { result: UNAVAILABLE + mask(err instanceof Error ? err.message : String(err)) }
      } finally {
        blink.cancel()
        isDotOn = true
      }
    }).catch(() => ({ result: UNAVAILABLE + 'the hook failed' }))
  } else {
    // A registration from before a reload stays in the pool: take it out.
    on('tool.list', async ($, e, next) => {
      const listed = await next(e)
      return listed.value === undefined ? listed : { value: listed.value.filter(t => t.name !== TOOL) }
    })
  }

  // Draws the row as the native advisor does: "● Advising using <model>".
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { isErrored, isInterrupted } = e.props
    const isRunning = e.props.isRunning || (e.props.output === undefined && !isErrored && !isInterrupted)
    const dotColor = isRunning ? 'inactive' : isErrored || isInterrupted ? 'error' : 'success'
    return (
      <Box flexDirection="row">
        <Text color={dotColor}>{isRunning && !isDotOn ? ' ' : '●'}</Text>
        <Text> </Text>
        <Text bold>Advising</Text>
        <Text color="inactive">{' using ' + (NAMES[settings.model] ?? settings.model)}</Text>
      </Box>
    )
  })

  // The advice itself shows in the detailed transcript (ctrl+o).
  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, ($, e, next) => {
    if (e.props.isExpanded === true) return next(e)
    const { Text } = $.ui.resolve(e)
    const text = typeof e.props.output === 'string' ? e.props.output : ''
    const isFailed = e.props.isErrored || text.startsWith(UNAVAILABLE)
    return <Text color={isFailed ? 'error' : 'inactive'}>{'  ⎿  ' + (isFailed ? text : REVIEWED)}</Text>
  })

  on('command.run', { command: 'gpt-advisor' }, async ($, e) => {
    const [key = '', value = ''] = e.args.trim().split(/\s+/)
    if (key === '') return { text: describe(settings) }
    if (key !== 'model' && key !== 'mode') {
      return { text: 'Usage: /gpt-advisor [model <name> | mode alongside|replace]\n' + describe(settings) }
    }
    const set = await $.config.set({ key: $.plugin.name + '.' + key, value })
    return set.deny === undefined
      ? { text: describe({ ...settings, [key]: value }) }
      : { text: 'Not changed: ' + set.deny + '\n' + describe(settings) }
  })
}
