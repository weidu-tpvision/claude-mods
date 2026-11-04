import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, budgetColor, colorFor } from '../hooks/band'
import { ROWS } from '../hooks/prices'
import { costOf, familyOf, scopeFor } from '../hooks/pricing'
import type { Price, Row } from '../hooks/pricing'
import { dateOf } from '../hooks/register'

const PANE = {
  plugin: 'bedrock-meter',
  component: 'Pane',
  requestId: 'bedrock-meter',
  props: {
    title: 'Bedrock meter',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const cents = (n: number | undefined) => Math.round((n ?? 0) * 100)

const USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
}

// One request of USAGE on a us. Opus 5.5 profile, at the table's regional rates.
const opusRegional = () => {
  const p = ROWS.find(r => r.family === 'opus-5-5')!.regional!
  return p.input + p.cacheWrite + p.cacheRead + p.output
}
const dollars = (n: number) => new RegExp(`\\$${n.toFixed(2).replace('.', '\\.')}`)

const SID = 's1'
const DIR = '/h/.claude/projects/-w'

// Times on 21 October 2026 in the machine's own time zone, so the dates the
// mod derives come out the same wherever the tests run.
const at = (hour: number, minute = 0) => new Date(2026, 9, 21, hour, minute).getTime()

// Two lines of one message (a line per content block), then a second message.
const TRANSCRIPT = [
  { type: 'assistant', timestamp: new Date(at(10)).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', usage: USAGE } },
  { type: 'assistant', timestamp: new Date(at(10)).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', usage: USAGE } },
  { type: 'user', message: { content: 'hi' } },
  { type: 'assistant', timestamp: new Date(at(10, 1)).toISOString(), message: { id: 'm2', model: 'claude-opus-5-5', usage: USAGE } },
]
  .map(row => JSON.stringify(row))
  .join('\n')

// The engine beneath the plugin: a Bedrock session whose transcript is on disk.
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }
const NOW = at(12)
const CONTEXT = { tokens: 84_000, window: 200_000, percent: 42 }

// `size`: what fs.stat says of the transcript (over 4 MiB, it is streamed);
// `startedAt`: the session's first launch, as session.usage reports it.
// `files`: other transcripts on disk, by path; `isSeeded: false` leaves the
// old transcripts' scan to run; `writes`: what fs.write wrote, by path.
type Extra = {
  size?: number
  startedAt?: number
  cats?: string[]
  files?: Record<string, string>
  isSeeded?: boolean
  writes?: Record<string, string>
  toasts?: string[]
  opened?: unknown[]
}

function engine(
  on: On,
  transcript: string | undefined,
  store: Record<string, unknown> = {},
  isStoreBroken = () => false,
  extra: Extra = {},
) {
  mock.clock(on, { now: NOW })
  // The plugin's store, kept here so a test can read what is left in it.
  const seeded = extra.isSeeded === false ? {} : { 'history:seeded': { at: 0, sessions: 0 } }
  const kept = new Map(Object.entries({ ...seeded, ...store }))
  const files = extra.files ?? {}
  const own: Record<string, string> = transcript === undefined ? {} : { [`${DIR}/${SID}.jsonl`]: transcript }
  const disk: Record<string, string> = { ...files, ...own }
  const isDir = (path: string) => Object.keys(disk).some(f => f.startsWith(`${path}/`))
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    if (isStoreBroken()) throw new Error('disk full')
    return (kept.set(e.key, e.value), { value: undefined })
  })
  on('store.delete', (_, e) => (kept.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...kept.keys()] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (extra.toasts?.push(e.text), { value: undefined }))
  on('ui.open', (_, e) => (extra.opened?.push(e), { value: { isPlaced: true } }))
  on('fs.write', (_, e) => ((extra.writes ??= {})[e.path] = e.text, { value: undefined }))
  on('command.register', () => ({ value: { command: 'bedrock-cost' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'us.anthropic.claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: extra.startedAt ?? at(9), context: { window: 200_000 }, rateLimits: [], cost: { usd: 5 } } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: [SUMMARY], usage: USAGE }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in disk || isDir(e.path) }))
  // A folder's entries: its files, and the folders that lead to deeper ones.
  on('fs.list', (_, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(disk)) {
      if (!f.startsWith(`${e.path}/`)) continue
      const [name, ...deeper] = f.slice(e.path.length + 1).split('/')
      names.set(name!, deeper.length > 0 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? disk[`${e.path}/${name}`]!.length : 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    if ((extra.size ?? 0) > 4 * 1024 * 1024) throw new Error(`${e.path}: over 4 MiB`)
    return { value: disk[e.path] ?? '' }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'file' as const, size: e.path === `${DIR}/${SID}.jsonl` ? (extra.size ?? (transcript ?? '').length) : (disk[e.path] ?? '').length, mtimeMs: 0, isLink: false } }))
  // cat hands the file over in pieces that end mid-line.
  on('process.spawn', async function* (_, e) {
    extra.cats?.push(e.argv.join(' '))
    const text = transcript ?? ''
    for (let i = 0; i < text.length; i += 97) yield { stream: 'stdout' as const, text: text.slice(i, i + 97) }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const,
      usage: { ...USAGE, model: 'us.anthropic.claude-opus-5-5' },
    }
  })
  return kept
}

async function sessionLine(mount: () => Promise<{ find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined>; unmount: () => Promise<void> }>) {
  const ui = await mount()
  const text = (await ui.find({ type: 'Text', text: /^Session / }))?.text
  await ui.unmount()
  return text
}

test('Bedrock model ids map to their family', async () => {
  expect(familyOf('us.anthropic.claude-opus-5-5')).toBe('opus-5-5')
  expect(familyOf('global.anthropic.claude-opus-5')).toBe('opus-5')
  expect(familyOf('anthropic.claude-opus-4-1-20250805-v1:0')).toBe('opus-4-1')
  expect(familyOf('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe('sonnet-4')
  expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
  expect(familyOf('mistral.large')).toBe(undefined)
})

// A million of each kind of token at a tier's rates: what USAGE costs there.
const million = (p: Price | undefined) => cents(p && p.input + p.cacheWrite + p.cacheRead + p.output)
const row = (family: string) => ROWS.find(r => r.family === family)!

test('the profile picks the tier: global. ids at global rates, the rest at regional', async () => {
  expect(scopeFor('global.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5')).toBe('global')
  expect(scopeFor('us.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5')).toBe('regional')
  expect(scopeFor('claude-opus-5-5', 'global.anthropic.claude-opus-5-5')).toBe('global')
  expect(scopeFor('claude-opus-5-5', 'us.anthropic.claude-opus-5-5')).toBe('regional')
  expect(scopeFor('anthropic.claude-opus-4-1-20250805-v1:0', 'x')).toBe('regional')
})

test('prices come from the AWS table, each tier its own', async () => {
  const opus = row('opus-5-5')
  expect(cents(costOf('global.anthropic.claude-opus-5-5', USAGE, 'global', 10))).toBe(million(opus.global))
  expect(cents(costOf('us.anthropic.claude-opus-5-5', USAGE, 'regional', 10))).toBe(million(opus.regional))
  // A model sold regionally alone bills its regional rates, whatever the profile.
  const old = ROWS.find(r => r.regional && !r.global)!
  expect(cents(costOf(`claude-${old.family}`, USAGE, 'global', 10))).toBe(million(old.regional))
  // A regional request on a model listed globally alone: global rates plus the premium.
  const globalOnly: Row[] = [{ family: 'opus-5-5', global: opus.global }]
  ROWS.splice(0, ROWS.length, ...globalOnly, ...ROWS)
  expect(cents(costOf('us.anthropic.claude-opus-5-5', USAGE, 'regional', 10))).toBe(Math.round(million(opus.global) * 1.1))
  ROWS.shift()
  expect(costOf('mistral.large', USAGE, 'regional', 10)).toBe(undefined)
})

test('Haiku 5.5 bills long prompts at its long-context rates', async () => {
  const haiku = row('haiku-5-5')
  expect(haiku.globalLong).toBeDefined()
  const small = { ...USAGE, input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  const big = { ...small, input_tokens: 200_000 }
  // In millionths of a cent, so the rates' decimals compare exactly.
  const tiny = (n: number | undefined) => Math.round((n ?? 0) * 1e8)
  expect(tiny(costOf('global.anthropic.claude-haiku-5-5', small, 'global'))).toBe(tiny((1000 * haiku.global!.input) / 1e6))
  expect(tiny(costOf('global.anthropic.claude-haiku-5-5', big, 'global'))).toBe(tiny((200_000 * haiku.globalLong!.input) / 1e6))
})

test('requests before the mod loaded come from the transcript, once each', async ($, on) => {
  engine(on, TRANSCRIPT)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    // Two messages: m1's repeated line counts once.
    expect(await sessionLine(() => $.ui.mount({ ...PANE, surface }))).toMatch(dollars(2 * opusRegional()))
  }

  // A live request adds to the backfill; a reload's session.start does not redo it.
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'us.anthropic.claude-opus-5-5', messageCount: 1 })) {
  }
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(dollars(3 * opusRegional()))
})

async function paneLine($: { ui: { mount: (t: never) => Promise<any> } }, start: RegExp) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  const text: string | undefined = (await ui.find({ type: 'Text', text: start }))?.text
  await ui.unmount()
  return text
}

const ONE = { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 1, isPriced: true }

test('without a transcript, Claude Code\'s estimate plus the premium stands in', async ($, on) => {
  // Begun today: all of Claude Code's total is today's, replacing an earlier run's count.
  const kept = engine(on, undefined, { 'day:2026-10-21:s1': ONE, 'day:2026-10-21:other': ONE })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(/\$5\.50/)
  expect(await paneLine($, /^Today/)).toMatch(/\$6\.50/)
  expect(cents((kept.get('day:2026-10-21:s1') as typeof ONE).usd)).toBe(550)
})

test('a session resumed on a later day keeps its earlier days out of today', async ($, on) => {
  const yesterday = new Date(2026, 9, 20, 15).getTime()
  const resumed = [
    { type: 'assistant', timestamp: new Date(yesterday).toISOString(), message: { id: 'm1', model: 'claude-opus-5-5', usage: USAGE } },
    { type: 'assistant', timestamp: new Date(at(10)).toISOString(), message: { id: 'm2', model: 'claude-opus-5-5', usage: USAGE } },
  ].map(row => JSON.stringify(row)).join('\n')
  const kept = engine(on, resumed, { 'day:2026-10-20:s1': { ...ONE, usd: 99 }, 'day:2026-10-21:other': ONE }, () => false, { startedAt: yesterday })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(dollars(2 * opusRegional()))
  expect(await paneLine($, /^Today/)).toMatch(dollars(opusRegional() + 1))
  // Yesterday is rebuilt from the transcript, not added to.
  expect(cents((kept.get('day:2026-10-20:s1') as typeof ONE).usd)).toBe(cents(opusRegional()))
})

test('without a transcript, a resume from an earlier day does not put the earlier spend on today', async ($, on) => {
  const yesterday = new Date(2026, 9, 20, 15).getTime()
  const store = { 'day:2026-10-20:s1': { ...ONE, usd: 3 }, 'day:2026-10-21:s1': ONE, 'day:2026-10-21:other': ONE }
  const kept = engine(on, undefined, store, () => false, { startedAt: yesterday })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  // The session carries Claude Code's whole total; the days keep what was counted live.
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(/\$5\.50/)
  expect(await paneLine($, /^Today/)).toMatch(/\$2\.00/)
  expect((kept.get('day:2026-10-20:s1') as typeof ONE).usd).toBe(3)
})

test('a transcript over 4 MiB is streamed, and synthetic responses are left out', async ($, on) => {
  const synthetic = { type: 'assistant', timestamp: new Date(at(10, 2)).toISOString(), message: { id: 'm3', model: '<synthetic>', usage: { ...USAGE, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  const cats: string[] = []
  engine(on, `${TRANSCRIPT}\n${JSON.stringify(synthetic)}\n`, {}, () => false, { size: 8_000_000, cats })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(cats).toEqual([`cat -- ${DIR}/${SID}.jsonl`])
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(dollars(2 * opusRegional()))
  // No unpriced row, so the band's cost carries no "+".
  expect(await paneLine($, /unpriced/)).toBe(undefined)
  expect(await bandLine($, 200)).not.toMatch(/\+/)
})

const BAND = (bodyColumns: number) =>
  ({
    plugin: 'bedrock-meter',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns },
  }) as never

// The band's own line: every Text but the engine's, joined as drawn.
async function bandLine($: { ui: { mount: (t: never) => Promise<any> } }, bodyColumns: number) {
  const ui = await $.ui.mount(BAND(bodyColumns))
  const texts: { text?: string }[] = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text).filter(t => t !== 'engine band').join('')
}

const TALLY = { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 1, isPriced: true }

test('helpers: local dates, bars and colors', async () => {
  // 01:30 local on the 22nd: a UTC date says the 21st east of Greenwich.
  expect(dateOf(new Date(2026, 9, 22, 1, 30).getTime())).toBe('2026-10-22')
  expect(bar(0, 5)).toBe('▁▁▁▁▁')
  expect(bar(100, 5)).toBe('█████')
  expect(colorFor(74)).toBe('green')
  expect(colorFor(75)).toBe('yellow')
  expect(colorFor(90)).toBe('red')
  expect(budgetColor(5, 0)).toBe(undefined)
  expect(budgetColor(6, 10)).toBe(undefined)
  expect(budgetColor(7, 10)).toBe('yellow')
  expect(budgetColor(10, 10)).toBe('red')
})

test('the band shows cost, context and today, and sheds parts when narrow', async ($, on) => {
  engine(on, TRANSCRIPT)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: CONTEXT, rateLimits: [], changed: ['context'] })

  const two = `$${(2 * opusRegional()).toFixed(2)}`
  const wide = await bandLine($, 200)
  expect(wide).toBe(`Bedrock ${two} · ctx ${bar(42, 8)} 42% 84.0k/200.0k · in 4.0M out 2.0M · cache 2.0M 33% · today ${two} · month ${two}`)

  const narrow = await bandLine($, 40)
  expect(narrow).toContain(two)
  expect(narrow).toMatch(/42%/)
  expect(narrow).not.toMatch(/cache|in 4/)
  expect(narrow.length).toBeLessThanOrEqual(38)
})

test('the month adds up this calendar month\'s days, every session\'s', async ($, on) => {
  const store = {
    'day:2026-10-01:a': { ...ONE, usd: 2 },
    'day:2026-10-21:b': ONE,
    'day:2026-09-30:c': { ...ONE, usd: 40 }, // last month
  }
  engine(on, undefined, store)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: CONTEXT, rateLimits: [], changed: ['context'] })
  // This session's $5.50 estimate is today's: today $6.50, the month $8.50.
  expect(await paneLine($, /^Today/)).toMatch(/\$6\.50/)
  expect(await paneLine($, /^Month/)).toMatch(/\$8\.50/)
  expect(await bandLine($, 200)).toMatch(/today \$6\.50 · month \$8\.50$/)
  // Narrower, the token counts go first, then the context's figures, then
  // the cache: the month stays after them.
  const wide = await bandLine($, 200)
  const noTokens = wide.replace(/ · in \S+ out \S+/, '')
  const noWindow = noTokens.replace(/ \S+\/\S+ ·/, ' ·')
  const noCache = noWindow.replace(/ · cache \S+ \S+/, '')
  // The band has the body's width less 2.
  expect(await bandLine($, noTokens.length + 2)).toBe(noTokens)
  expect(await bandLine($, noTokens.length + 1)).toBe(noWindow)
  expect(await bandLine($, noWindow.length + 1)).toBe(noCache)
  expect(noCache).toMatch(/month \$8\.50$/)
})

// A budget the session's two requests come to 80% of.
const BUDGET = Math.round((2 * opusRegional()) / 0.8)

test('the cost turns yellow near the budget, with the budget beside it', { options: { budgetUsd: BUDGET } }, async ($, on) => {
  engine(on, TRANSCRIPT)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND(200))
  expect((await ui.find({ type: 'Text', text: dollars(2 * opusRegional()) }) as any)?.props?.color).toBe('yellow')
  await ui.unmount()
  expect(await bandLine($, 200)).toContain(`of $${BUDGET.toFixed(2)}`)
})

test('daily totals past 31 days roll up into the day\'s history; the first version\'s keys are dropped', async ($, on) => {
  const kept = engine(on, undefined, {
    'day:2026-08-01:old': TALLY,
    'day:2026-10-01:recent': TALLY,
    'day:2026-10-21': TALLY,
    'day:2026-10-21:other': TALLY,
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect([...kept.keys()].filter(k => /^(day|hist):/.test(k)).sort()).toEqual([
    'day:2026-10-01:recent',
    'day:2026-10-21:other',
    `day:2026-10-21:${SID}`,
    'hist:2026-08-01',
  ])
  // The old session's day lives on in the day's history, once.
  const hist = kept.get('hist:2026-08-01') as { total: typeof TALLY; sessions: Record<string, unknown> }
  expect(hist.total.usd).toBe(1)
  expect(Object.keys(hist.sessions)).toEqual(['old'])
  // Today: the other session's $1 and this one's $5.50 estimate.
  expect(await bandLine($, 200)).toMatch(/today \$6\.50/)
})

test('a compaction before any request this load is priced at the session\'s model', async ($, on) => {
  engine(on, undefined)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  // The $5.50 estimate and one Opus 5.5 request.
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(dollars(5.5 + opusRegional()))
})

test('a compaction goes through even when counting it fails', async ($, on) => {
  let isBroken = false
  engine(on, undefined, {}, () => isBroken)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  isBroken = true
  const r = await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(r.messages?.length).toBe(1)
})

const HISTORY_PANE = (bodyColumns = 80) =>
  ({
    plugin: 'bedrock-meter',
    component: 'Pane',
    requestId: 'bedrock-meter',
    surface: 'terminal',
    props: {
      title: 'Bedrock history',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as never

const line = (id: string, at: number, model = 'claude-sonnet-4-5', cwd = '/home/me/proj') =>
  JSON.stringify({ type: 'assistant', cwd, timestamp: new Date(at).toISOString(), message: { id, model, usage: USAGE } })

// Another session's transcript: one request 50 days back (past the 31 kept per
// session), one 2 days back, and one of a subagent's on that same day.
const OTHER = `${DIR}/old1.jsonl`
const OTHER_FILES = {
  [OTHER]: [line('o1', new Date(2026, 8, 1, 10).getTime()), line('o2', new Date(2026, 9, 19, 10).getTime())].join('\n'),
  [`${DIR}/old1/subagents/agent-a.jsonl`]: line('o3', new Date(2026, 9, 19, 11).getTime(), 'claude-haiku-4-5'),
}
const sonnetRegional = () => {
  const p = ROWS.find(r => r.family === 'sonnet-4-5')!.regional!
  return p.input + p.cacheWrite + p.cacheRead + p.output
}

test('old transcripts seed the history once: recent days per session, older ones rolled up', async ($, on) => {
  const kept = engine(on, TRANSCRIPT, {}, () => false, { isSeeded: false, files: OTHER_FILES })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'bedrock-cost', args: 'rescan' } as never)
  expect((r as { text?: string }).text).toMatch(/1 had Bedrock requests/)

  const recent = kept.get('day:2026-10-19:old1') as { usd: number; project?: string; models: Record<string, unknown> }
  expect(recent.project).toBe('/home/me/proj')
  expect(Object.keys(recent.models).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5'])
  const old = kept.get('hist:2026-09-01') as { total: { usd: number }; sessions: Record<string, { project?: string }> }
  expect(cents(old.total.usd)).toBe(cents(sonnetRegional()))
  expect(old.sessions.old1?.project).toBe('/home/me/proj')
  // This session is the backfill's, never the scan's.
  expect([...kept.keys()].some(k => k.startsWith('day:') && k.endsWith(':s1'))).toBe(true)
  expect(kept.get('history:seeded')).toBeDefined()

  // A second scan changes nothing: the old day's session is in it already.
  await $.command.run({ command: 'bedrock-cost', args: 'rescan' } as never)
  expect(cents((kept.get('hist:2026-09-01') as typeof old).total.usd)).toBe(cents(sonnetRegional()))
})

async function texts($: { ui: { mount: (t: never) => Promise<any> } }, act?: (ui: any) => Promise<void>) {
  const ui = await $.ui.mount(HISTORY_PANE())
  if (act) await act(ui)
  const all: { text?: string }[] = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return all.map(t => t.text ?? '').join('\n')
}

test('the history pane: totals, a histogram and breakdowns, picked by its buttons', async ($, on) => {
  const day = (usd: number, project: string, model = 'claude-opus-5-5') => ({ ...ONE, usd, project, models: { [model]: { ...ONE, usd } } })
  const store = {
    'day:2026-10-21:a': day(3, '/h/one'),
    'day:2026-10-20:b': day(2, '/h/two', 'claude-sonnet-4-5'),
    'day:2026-10-02:c': day(1, '/h/one'),
    'hist:2026-09-10': { total: { ...ONE, usd: 40 }, models: { 'claude-opus-5-5': { ...ONE, usd: 40 } }, sessions: { d: { usd: 40, project: '/h/two' } } },
  }
  engine(on, undefined, store, () => false, { startedAt: at(9) })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  // The pane opens on the session; the history is a tab of it.
  expect(await texts($)).toMatch(/^Session \$5\.50/m)
  // Today: a's $3 and this session's $5.50 estimate.
  const overview = await texts($, async ui => {
    await ui.press({ key: 'tab-overview' })
  })
  expect(overview).toMatch(/All time/)
  expect(overview).toMatch(/\$51\.50/) // 40 + 1 + 2 + 3 + 5.50
  expect(overview).toMatch(/since 2026-09-10/)
  expect(overview).toMatch(/Last month[\s\S]*\$40\.00/)
  expect(overview).toMatch(/This month[\s\S]*\$11\.50/)
  expect(overview).toMatch(/Today[\s\S]*\$8\.50/)

  const months = await texts($, async ui => {
    await ui.press({ key: 'tab-chart' })
  })
  // Weeks by default; the week of Mon 10-19 holds b, a and this session.
  expect(months).toMatch(/wk 10-19\s+\$10\.50/)

  const byMonth = await texts($, async ui => {
    await ui.press({ key: 'pick-month' })
  })
  expect(byMonth).toMatch(/Sep 2026\s+\$40\.00/)
  expect(byMonth).toMatch(/Oct 2026\s+\$11\.50/)

  const projects = await texts($, async ui => {
    await ui.press({ key: 'tab-breakdown' })
    await ui.press({ key: 'pick-project' })
  })
  expect(projects).toMatch(/~\/two\s+\$42\.00/)
  expect(projects).toMatch(/~\/one\s+\$4\.00/)

  // This month alone: d's September falls out.
  const month = await texts($, async ui => {
    await ui.press({ key: 'range' })
  })
  expect(month).toMatch(/~\/two\s+\$2\.00/)
})

test('the monthly budget toasts once when the month passes it', { options: { monthBudgetUsd: 6 } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, undefined, { 'day:2026-10-03:x': { ...ONE, usd: 1 } }, () => false, { toasts })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  // $1 + this session's $5.50: past $6.
  expect(toasts.filter(t => /this month passed \$6/.test(t)).length).toBe(1)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'us.anthropic.claude-opus-5-5', messageCount: 1 })) {
  }
  expect(toasts.filter(t => /this month passed/.test(t)).length).toBe(1)
})

test('export writes a row per day and model, and per day and session', async ($, on) => {
  const writes: Record<string, string> = {}
  const store = { 'day:2026-10-20:b': { ...ONE, usd: 2, project: '/h/two', models: { 'claude-sonnet-4-5': { ...ONE, usd: 2 } } } }
  engine(on, undefined, store, () => false, { writes })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'bedrock-cost', args: 'export ~/out.csv' } as never)
  expect(writes['/h/out.csv']).toMatch(/^date,model,requests,/)
  expect(writes['/h/out.csv']).toContain('2026-10-20,claude-sonnet-4-5,1,0,0,0,0,2')
  expect(writes['/h/out-sessions.csv']).toContain('2026-10-20,b,/h/two,2')
})

test('/bedrock-cost opens the one pane on the session, history on the overview; Esc closes it', async ($, on) => {
  const opened: unknown[] = []
  engine(on, TRANSCRIPT, {}, () => false, { opened })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'bedrock-cost', args: 'history' } as never)
  expect(await texts($)).toMatch(/All time/)
  await $.command.run({ command: 'bedrock-cost', args: '' } as never)
  expect(await texts($)).toMatch(/^Session /m)
  expect(opened).toEqual([
    expect.objectContaining({ id: 'bedrock-meter', focus: true, closeOnEscape: true }),
    expect.objectContaining({ id: 'bedrock-meter', focus: true, closeOnEscape: true }),
  ])
})
