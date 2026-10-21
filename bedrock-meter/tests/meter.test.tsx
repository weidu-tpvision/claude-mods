import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, budgetColor, colorFor } from '../hooks/band'
import { costOf, familyOf, premiumFor } from '../hooks/pricing'
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

const SID = 's1'
const DIR = '/h/.claude/projects/-w'

// Two lines of one message (a line per content block), then a second message.
const TRANSCRIPT = [
  { type: 'assistant', timestamp: '2026-10-21T10:00:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: USAGE } },
  { type: 'assistant', timestamp: '2026-10-21T10:00:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: USAGE } },
  { type: 'user', message: { content: 'hi' } },
  { type: 'assistant', timestamp: '2026-10-21T10:01:00Z', message: { id: 'm2', model: 'claude-opus-5-5', usage: USAGE } },
]
  .map(row => JSON.stringify(row))
  .join('\n')

// The engine beneath the plugin: a Bedrock session whose transcript is on disk.
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }
const NOW = Date.parse('2026-10-21T12:00:00Z')
const CONTEXT = { tokens: 84_000, window: 200_000, percent: 42 }

function engine(on: On, transcript: string | undefined, store: Record<string, unknown> = {}) {
  mock.clock(on, { now: NOW })
  // The plugin's store, kept here so a test can read what is left in it.
  const kept = new Map(Object.entries(store))
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => (kept.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (kept.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...kept.keys()] }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'bedrock-cost' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'us.anthropic.claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 5 } } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.compact', () => ({ messages: [SUMMARY], usage: USAGE }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.exists', (_, e) => ({ value: transcript !== undefined && e.path === `${DIR}/${SID}.jsonl` }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: transcript ?? '' }))
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

test('prices add up, with the premium on regional and geo profiles only', async () => {
  // Opus 5.5: 4 in + 5 write + 0.2 read + 20 out
  expect(cents(costOf('us.anthropic.claude-opus-5-5', USAGE))).toBe(2920)
  expect(premiumFor('global.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5', 10)).toBe(0)
  expect(premiumFor('us.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 10)).toBe(10)
  expect(premiumFor('claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 10)).toBe(0)
  expect(premiumFor('claude-opus-5-5', 'us.anthropic.claude-opus-5-5', 10)).toBe(10)
  expect(cents(costOf('us.anthropic.claude-opus-5-5', USAGE, 10))).toBe(3212)
  expect(costOf('mistral.large', USAGE, 10)).toBe(undefined)
})

test('requests before the mod loaded come from the transcript, once each', async ($, on) => {
  engine(on, TRANSCRIPT)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    // Two messages at $32.12: m1's repeated line counts once.
    expect(await sessionLine(() => $.ui.mount({ ...PANE, surface }))).toMatch(/\$64\.24/)
  }

  // A live request adds to the backfill; a reload's session.start does not redo it.
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'us.anthropic.claude-opus-5-5', messageCount: 1 })) {
  }
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(/\$96\.36/)
})

test('without a transcript, Claude Code\'s estimate plus the premium stands in', async ($, on) => {
  engine(on, undefined)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(/\$5\.50/)
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

  const wide = await bandLine($, 200)
  expect(wide).toMatch(/^Bedrock \$64\.24 · ctx \S+ 42% 84\.0k\/200\.0k · in 4\.0M out 2\.0M · cache 2\.0M 33% · today \$64\.24$/)

  const narrow = await bandLine($, 40)
  expect(narrow).toMatch(/\$64\.24/)
  expect(narrow).toMatch(/42%/)
  expect(narrow).not.toMatch(/cache|in 4/)
  expect(narrow.length).toBeLessThanOrEqual(38)
})

test('the cost turns yellow near the budget, with the budget beside it', { options: { budgetUsd: 80 } }, async ($, on) => {
  engine(on, TRANSCRIPT)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND(200))
  expect((await ui.find({ type: 'Text', text: /^\$64\.24$/ }) as any)?.props?.color).toBe('yellow')
  await ui.unmount()
  expect(await bandLine($, 200)).toMatch(/of \$80\.00/)
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
  // $5.50 estimate + one Opus 5.5 request at $32.12.
  expect(await sessionLine(() => $.ui.mount({ ...PANE, surface: 'terminal' }))).toMatch(/\$37\.62/)
})
