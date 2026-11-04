import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Context, Meter, Tally } from '../types'
import { drawBand, hitRate, tokens, usd } from './band'
import { bandsFile, parseOrder, stackBands } from './bands'
import { PUBLISHED } from './prices'
import { costOf, scopeFor } from './pricing'
import type { Usage } from './pricing'

const PANE = 'bedrock-meter'
const EMPTY: Meter = { byModel: {}, isWarned: false, isBackfilled: false }
const EARLIER = 'earlier requests (Claude Code estimate)'

const ZERO: Tally = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, isPriced: true }

const meter = atom({ plugin: 'bedrock-meter', key: 'meter' } as const, EMPTY)
const context = atom({ plugin: 'bedrock-meter', key: 'context' } as const, null as Context | null)
const todayTally = atom({ plugin: 'bedrock-meter', key: 'today' } as const, ZERO)
const monthTally = atom({ plugin: 'bedrock-meter', key: 'month' } as const, ZERO)

// Daily totals older than this are dropped at each session start; it covers
// the longest month, so the month's total always has its first day.
const KEEP_DAYS = 31
const DAY_MS = 86_400_000
const TICK_MS = 60_000

// `us.anthropic.claude-opus-5-5` and the transcript's `claude-opus-5-5` share a row.
const rowOf = (model: string) => model.replace(/^.*anthropic\./, '')

const add = (t: Tally, u: Usage, cost: number | undefined): Tally => ({
  requests: t.requests + 1,
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  usd: t.usd + (cost ?? 0),
  isPriced: t.isPriced && cost !== undefined,
})

const sum = (tallies: Tally[]): Tally =>
  tallies.reduce(
    (all, t) => ({
      requests: all.requests + t.requests,
      input: all.input + t.input,
      output: all.output + t.output,
      cacheRead: all.cacheRead + t.cacheRead,
      cacheWrite: all.cacheWrite + t.cacheWrite,
      usd: all.usd + t.usd,
      isPriced: all.isPriced && t.isPriced,
    }),
    ZERO,
  )

const pad = (n: number) => String(n).padStart(2, '0')

// The local calendar day, so "today" turns over at the person's midnight.
export const dateOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Daily totals are kept per session (`day:<date>:<session>`), so rebuilding
// one session's figures never counts another's twice. Today and this month
// (local calendar) are summed from them.
async function refreshToday($: EngineInterface) {
  const date = dateOf(await $.clock.now())
  const keys = (await $.store.keys()).filter(key => key.startsWith(`day:${date.slice(0, 7)}-`))
  const tallies = await Promise.all(
    keys.map(async key => [key, ((await $.store.get(key)) as Tally | undefined) ?? ZERO] as const),
  )
  await update($, todayTally, () => sum(tallies.filter(([key]) => key.startsWith(`day:${date}:`)).map(([, t]) => t)))
  await update($, monthTally, () => sum(tallies.map(([, t]) => t)))
}

// Drops the days past KEEP_DAYS, and the per-day keys of the first version.
async function prune($: EngineInterface) {
  const cutoff = dateOf((await $.clock.now()) - KEEP_DAYS * DAY_MS)
  for (const key of await $.store.keys()) {
    const date = /^day:(\d{4}-\d\d-\d\d)(:|$)/.exec(key)
    if (date && (date[2] === '' || date[1]! < cutoff)) await $.store.delete(key)
  }
}

type Settings = { premiumPct: number; budgetUsd: number }

async function record($: EngineInterface, model: string, u: Usage, settings: Settings) {
  const cost = costOf(model, u, scopeFor(model, await $.session.model()), settings.premiumPct)
  await update($, meter, m => ({
    ...m,
    byModel: { ...m.byModel, [rowOf(model)]: add(m.byModel[rowOf(model)] ?? ZERO, u, cost) },
  }))

  const key = `day:${dateOf(await $.clock.now())}:${await $.session.id()}`
  await $.store.set(key, add(((await $.store.get(key)) as Tally | undefined) ?? ZERO, u, cost))
  await refreshToday($)

  const m = await read($, meter)
  const spent = sum(Object.values(m.byModel)).usd
  if (settings.budgetUsd > 0 && !m.isWarned && spent >= settings.budgetUsd) {
    await update($, meter, one => ({ ...one, isWarned: true }))
    $.ui.toast(`Bedrock session passed ${usd(settings.budgetUsd)} (now ${usd(spent)})`)
  }
}

// `at`: the response's time in ms, NaN when the line carries none.
type Turn = { model: string; usage: Usage; at: number }

// Claude Code's stand-in for a response that never came (an interrupted or
// failed request): no tokens, and no model to price, so it is left out.
const SYNTHETIC = '<synthetic>'

// One response per message id: the transcript writes a line per content block.
function parseLine(line: string, into: Map<string, Turn>) {
  if (!line.includes('"usage"')) return
  try {
    const row = JSON.parse(line)
    const message = row?.message
    const u = message?.usage
    if (row?.type !== 'assistant' || !u || typeof message.id !== 'string') return
    if (message.model === SYNTHETIC) return
    into.set(message.id, {
      model: String(message.model ?? 'unknown'),
      at: Date.parse(String(row.timestamp ?? '')),
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      },
    })
  } catch {
    // A line cut short while being written: the next load reads it whole.
  }
}

function parseTranscript(text: string, into: Map<string, Turn>) {
  for (const line of text.split('\n')) parseLine(line, into)
}

// What one $.fs.read takes; a longer transcript is streamed instead.
const READ_LIMIT = 4 * 1024 * 1024

type TranscriptFile = { path: string; size: number }

// A transcript into `into`: read whole when it fits one $.fs.read, else
// streamed through `cat` a piece at a time, so a long session's file (a day
// of work passes 4 MiB) is still read back. Rejects when it cannot be read.
async function readTranscript($: EngineInterface, file: TranscriptFile, into: Map<string, Turn>) {
  if (file.size <= READ_LIMIT) return parseTranscript(await $.fs.read(file.path), into)
  let rest = ''
  const cat = $.process.spawn({ argv: ['cat', '--', file.path] })
  for await (const piece of cat) {
    if (piece.stream !== 'stdout') continue
    const lines = (rest + piece.text).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) parseLine(line, into)
  }
  const end = await cat.result
  if (end.code !== 0) throw new Error(`cat ${file.path}: exit ${end.code ?? end.signal}`)
  parseLine(rest, into)
}

// The session's transcript and its subagents', or undefined when the
// session's own cannot be found.
async function transcriptFiles($: EngineInterface, sid: string): Promise<TranscriptFile[] | undefined> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const projects = `${config}/projects`
  const slug = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
  let dir = `${projects}/${slug}`
  if (!(await $.fs.exists(`${dir}/${sid}.jsonl`))) {
    const all = await $.fs.list(projects)
    const found = []
    for (const entry of all) {
      if (entry.kind === 'dir' && (await $.fs.exists(`${projects}/${entry.name}/${sid}.jsonl`))) found.push(entry.name)
    }
    if (found.length === 0) return undefined
    dir = `${projects}/${found[0]}`
  }
  const main = `${dir}/${sid}.jsonl`
  const files = [{ path: main, size: (await $.fs.stat(main)).size }]
  const subagents = `${dir}/${sid}/subagents`
  if (await $.fs.exists(subagents)) {
    for (const entry of await $.fs.list(subagents)) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) files.push({ path: `${subagents}/${entry.name}`, size: entry.size })
    }
  }
  return files
}

// Counts what the session spent before the mod loaded, once per session.
async function backfill($: EngineInterface, settings: Settings) {
  if ((await read($, meter)).isBackfilled) return
  const sid = await $.session.id()
  const sessionModel = await $.session.model()
  const now = await $.clock.now()
  const today = dateOf(now)
  const ownKeys = (await $.store.keys()).filter(key => key.startsWith('day:') && key.endsWith(`:${sid}`))

  const turns = new Map<string, Turn>()
  let isRead = false
  try {
    const files = await transcriptFiles($, sid)
    if (files) {
      for (const file of files) await readTranscript($, file, turns)
      isRead = true
    }
  } catch {
    isRead = false
  }

  const byModel: Record<string, Tally> = {}
  const days: Record<string, Tally> = {}
  if (isRead) {
    // The transcript holds every request: each day of this session is rebuilt from it.
    for (const key of ownKeys) await $.store.delete(key)
    for (const turn of turns.values()) {
      const cost = costOf(turn.model, turn.usage, scopeFor(turn.model, sessionModel), settings.premiumPct)
      const date = dateOf(Number.isFinite(turn.at) ? turn.at : now)
      byModel[rowOf(turn.model)] = add(byModel[rowOf(turn.model)] ?? ZERO, turn.usage, cost)
      days[date] = add(days[date] ?? ZERO, turn.usage, cost)
    }
  } else {
    // Claude Code's total, priced at the global rates: a regional session adds
    // the premium. It counts from the session's first launch, a resume's
    // earlier runs too, as one sum with no dates. All of it is today's only
    // when the session began today; otherwise the days stay as the meter
    // counted them live, and the session total alone carries the rest.
    const usage = await $.session.usage()
    const engine = usage.cost?.usd ?? 0
    if (engine > 0) {
      const premium = scopeFor(sessionModel, sessionModel) === 'regional' ? settings.premiumPct : 0
      const tally = { ...ZERO, usd: engine * (1 + premium / 100) }
      byModel[EARLIER] = tally
      if (dateOf(usage.startedAt) === today) {
        for (const key of ownKeys) await $.store.delete(key)
        days[today] = tally
      }
    }
  }

  await update($, meter, () => ({ byModel, isWarned: false, isBackfilled: true }))
  for (const [date, tally] of Object.entries(days)) await $.store.set(`day:${date}:${sid}`, tally)
}

// The band order file, as hamzafer's claude-code-mods checklist saves it; [] on any error.
async function readBandOrder($: EngineInterface): Promise<string[]> {
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    premiumPct: Number(options.regionalPremiumPct ?? 10),
    budgetUsd: Number(options.budgetUsd ?? 0),
  }
  let lastModel = ''
  let timer: Timer | undefined
  let bandOrder: Promise<string[]> | undefined // read once per load

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'bedrock-cost',
      description: 'Show Bedrock token usage and estimated cost by model',
    })
    if (options.openPane === true) void $.ui.open({ id: PANE, title: 'Bedrock meter' })
    $.ui.status(undefined) // the band took over from the status line of the first version
    await prune($)
    await backfill($, settings)
    await refreshToday($)
    const usage = await $.session.usage().catch(() => undefined)
    if (usage) {
      const { tokens, window, percent } = usage.context
      await update($, context, () => ({ tokens, window, percent }))
    }

    // Moves "today" on at the local midnight, with no request to trigger it.
    let day = dateOf(await $.clock.now())
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = dateOf(await $.clock.now())
        if (now !== day) {
          day = now
          await refreshToday($)
        }
      })().catch(() => {})
    })
    return r
  })

  on('command.run', { command: 'bedrock-cost' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Bedrock meter' })
    const total = sum(Object.values((await read($, meter)).byModel))
    const line =
      total.requests > 0
        ? `${usd(total.usd)} this session over ${total.requests} requests (cache hit ${hitRate(total)}%).`
        : `${usd(total.usd)} this session (Claude Code's estimate of the requests before the meter loaded).`
    return { text: opened.isPlaced ? line : `${line} Widen the terminal to see the pane.` }
  })

  // Every model request of every turn, main loop and subagents alike.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r.usage) {
      lastModel = r.usage.model
      await record($, r.usage.model, r.usage, settings)
    }
    return r
  })

  // The summarizer's own request when the engine compacts. Its usage names no
  // model: the last one seen, or the session's before any request this load.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if ('usage' in r && r.usage) await record($, lastModel || (await $.session.model()), r.usage, settings)
    return r
  }).catch(($, e, next) => next(e)) // a failed count never holds up the compaction: replays it, or runs it

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await update($, context, () => ({ tokens: e.context.tokens, window: e.context.window, percent: e.context.percent }))
    return r
  })

  // A cleared session starts from nothing; there is no transcript to read back.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, meter, () => ({ ...EMPTY, isBackfilled: true }))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    if (e.props.hasSurvey) return rest
    const m = await read($, meter)
    const figures = {
      total: sum(Object.values(m.byModel)),
      today: await read($, todayTally),
      month: await read($, monthTally),
      budgetUsd: settings.budgetUsd,
      context: await read($, context),
    }
    const mine = drawBand($.ui.resolve(e), figures, e.props.bodyColumns - 2)
    if (!mine) return rest
    bandOrder ??= readBandOrder($).catch(() => [])
    return stackBands(rest, 'bedrock-meter', mine, 'above', await bandOrder)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const m = await read($, meter)
    const total = sum(Object.values(m.byModel))
    const day = await read($, todayTally)
    const month = await read($, monthTally)
    const ctx = await read($, context)
    const engine = (await $.session.usage()).cost?.usd
    const rows = Object.entries(m.byModel).sort(([, a], [, b]) => b.usd - a.usd)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No Bedrock requests yet.</Text>}
        {rows.map(([model, t]) => (
          <Box flexDirection="column" key={model}>
            <Text bold>{model}</Text>
            <Text>
              {'  '}
              {usd(t.usd)}
              {t.isPriced ? '' : ' (unpriced model)'}
              {t.requests > 0 ? ` · ${t.requests} req` : ''}
            </Text>
            {t.requests > 0 && (
              <Text dimColor>
                {'  '}in {tokens(t.input)} · write {tokens(t.cacheWrite)} · read {tokens(t.cacheRead)} · out{' '}
                {tokens(t.output)}
              </Text>
            )}
          </Box>
        ))}
        {rows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              Session {usd(total.usd)} · cache hit {hitRate(total)}%
            </Text>
            <Text>Today {usd(day.usd)} · out {tokens(day.output)}</Text>
            <Text>Month {usd(month.usd)} · out {tokens(month.output)}</Text>
            {ctx?.percent !== undefined && (
              <Text>
                Context {Math.round(ctx.percent)}%
                {ctx.tokens !== undefined ? ` · ${tokens(ctx.tokens)} of ${tokens(ctx.window)}` : ''}
              </Text>
            )}
            {engine !== undefined && <Text dimColor>Claude Code /cost (global rates) {usd(engine)}</Text>}
            <Text dimColor>
              Prices: AWS list of {PUBLISHED.slice(0, 10)}
              {settings.budgetUsd > 0 ? ` · budget ${usd(settings.budgetUsd)}` : ''}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
