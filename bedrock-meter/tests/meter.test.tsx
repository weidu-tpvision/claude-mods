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
type Extra = { size?: number; startedAt?: number; cats?: string[] }

function engine(
  on: On,
  transcript: string | undefined,
  store: Record<string, unknown> = {},
  isStoreBroken = () => false,
  extra: Extra = {},
) {
  mock.clock(on, { now: NOW })
  // The plugin's store, kept here so a test can read what is left in it.
  const kept = new Map(Object.entries(store))
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    if (isStoreBroken()) throw new Error('disk full')
    return (kept.set(e.key, e.value), { value: undefined })
  })
  on('store.delete', (_, e) => (kept.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...kept.keys()] }))
  on('ui.status', () => ({ value: undefined }))
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
  on('fs.exists', (_, e) => ({ value: transcript !== undefined && e.path === `${DIR}/${SID}.jsonl` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_, e) => {
    if ((extra.size ?? 0) > 4 * 1024 * 1024) throw new Error(`${e.path}: over 4 MiB`)
    return { value: transcript ?? '' }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: extra.size ?? (transcript ?? '').length, mtimeMs: 0, isLink: false } }))
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
  const text = (await ui.find({ type: 'Text', text: /^Session/ }))?.text
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

test('daily totals past 31 days and the first version\'s keys are dropped', async ($, on) => {
  const kept = engine(on, undefined, {
    'day:2026-08-01:old': TALLY,
    'day:2026-10-01:recent': TALLY,
    'day:2026-10-21': TALLY,
    'day:2026-10-21:other': TALLY,
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect([...kept.keys()].sort()).toEqual(['day:2026-10-01:recent', 'day:2026-10-21:other', `day:2026-10-21:${SID}`])
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
