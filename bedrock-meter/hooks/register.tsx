import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Context, DayRecord, HistDay, HistoryView, Meter, Scan, Tally } from '../types'
import { drawBand, hitRate, tokens, usd } from './band'
import { bandsFile, parseOrder, stackBands } from './bands'
import { DAY_KEY, emptyHist, histKey, loadDays, mergeSession, toCsv } from './history'
import { drawPane } from './historyPane'
import { PUBLISHED } from './prices'
import { costOf, scopeFor } from './pricing'
import type { Usage } from './pricing'
import { add, dateOf, sum, ZERO } from './tally'

export { dateOf } from './tally'

const PANE = 'bedrock-meter'
// 0.4.0's separate history pane, now a tab of the one pane.
const OLD_HISTORY = 'bedrock-history'
const EMPTY: Meter = { byModel: {}, isWarned: false, isBackfilled: false }
const EARLIER = 'earlier requests (Claude Code estimate)'

const meter = atom({ plugin: 'bedrock-meter', key: 'meter' } as const, EMPTY)
const context = atom({ plugin: 'bedrock-meter', key: 'context' } as const, null as Context | null)
const todayTally = atom({ plugin: 'bedrock-meter', key: 'today' } as const, ZERO)
const monthTally = atom({ plugin: 'bedrock-meter', key: 'month' } as const, ZERO)
const VIEW: HistoryView = { tab: 'session', chart: 'week', by: 'model', range: 'all' }
const view = atom({ plugin: 'bedrock-meter', key: 'view' } as const, VIEW)
const scan = atom({ plugin: 'bedrock-meter', key: 'scan' } as const, { isRunning: false, done: 0, files: 0 } as Scan)

// Where the old transcripts' scan left its mark: once done, it is not run again
// on its own (`/bedrock-cost rescan` runs it).
const SEEDED = 'history:seeded'

// Daily totals per session older than this are rolled up into one record
// per day (`hist:<date>`) at each session start; it covers the longest month,
// so the month's total always has its first day among the per-session ones.
const KEEP_DAYS = 31
const DAY_MS = 86_400_000
const TICK_MS = 60_000

// `us.anthropic.claude-opus-5-5` and the transcript's `claude-opus-5-5` share a row.
const rowOf = (model: string) => model.replace(/^.*anthropic\./, '')

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

const cutoffOf = async ($: EngineInterface) => dateOf((await $.clock.now()) - KEEP_DAYS * DAY_MS)

// Rolls the per-session days past KEEP_DAYS into the day's history, and drops
// the per-day keys of the first version.
async function rollUp($: EngineInterface) {
  const cutoff = await cutoffOf($)
  for (const key of await $.store.keys()) {
    const day = DAY_KEY.exec(key)
    if (!day) continue
    const [, date, sid] = day
    if (sid !== undefined && date! >= cutoff) continue
    const r = (await $.store.get(key)) as DayRecord | undefined
    if (sid !== undefined && r) {
      const h = ((await $.store.get(histKey(date!))) as HistDay | undefined) ?? emptyHist()
      await $.store.set(histKey(date!), mergeSession(h, sid, r))
    }
    await $.store.delete(key)
  }
}

// A session's days: the recent ones replace its per-session records; one
// past KEEP_DAYS joins that day's history, unless the session is in it already.
async function writeDays($: EngineInterface, sid: string, days: Record<string, DayRecord>) {
  const cutoff = await cutoffOf($)
  for (const [date, r] of Object.entries(days)) {
    if (date >= cutoff) {
      await $.store.set(`day:${date}:${sid}`, r)
    } else {
      const h = ((await $.store.get(histKey(date))) as HistDay | undefined) ?? emptyHist()
      if (!h.sessions[sid]) await $.store.set(histKey(date), mergeSession(h, sid, r))
    }
  }
}

const addDay = (r: DayRecord | undefined, model: string, u: Usage, cost: number | undefined, project: string | undefined): DayRecord => {
  const one = r ?? { ...ZERO, models: {} }
  const models = one.models ?? {}
  return {
    ...add(one, u, cost),
    models: { ...models, [rowOf(model)]: add(models[rowOf(model)] ?? ZERO, u, cost) },
    project: one.project ?? project,
  }
}

type Settings = { premiumPct: number; budgetUsd: number; monthBudgetUsd: number }

// Toasts once a month, when the month's total passes the monthly budget.
async function checkMonthBudget($: EngineInterface, settings: Settings) {
  if (settings.monthBudgetUsd <= 0) return
  const month = await read($, monthTally)
  const key = `warned:${dateOf(await $.clock.now()).slice(0, 7)}`
  if (month.usd < settings.monthBudgetUsd || (await $.store.get(key))) return
  await $.store.set(key, true)
  $.ui.toast(`Bedrock this month passed ${usd(settings.monthBudgetUsd)} (now ${usd(month.usd)})`)
}

async function record($: EngineInterface, model: string, u: Usage, settings: Settings) {
  const cost = costOf(model, u, scopeFor(model, await $.session.model()), settings.premiumPct)
  await update($, meter, m => ({
    ...m,
    byModel: { ...m.byModel, [rowOf(model)]: add(m.byModel[rowOf(model)] ?? ZERO, u, cost) },
  }))

  const key = `day:${dateOf(await $.clock.now())}:${await $.session.id()}`
  await $.store.set(key, addDay((await $.store.get(key)) as DayRecord | undefined, model, u, cost, await $.session.root()))
  await refreshToday($)
  await checkMonthBudget($, settings)

  const m = await read($, meter)
  const spent = sum(Object.values(m.byModel)).usd
  if (settings.budgetUsd > 0 && !m.isWarned && spent >= settings.budgetUsd) {
    await update($, meter, one => ({ ...one, isWarned: true }))
    $.ui.toast(`Bedrock session passed ${usd(settings.budgetUsd)} (now ${usd(spent)})`)
  }
}

// `at`: the response's time in ms, NaN when the line carries none; `cwd`:
// the folder the session ran in, as the line says.
type Turn = { model: string; usage: Usage; at: number; cwd?: string }

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
      ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
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
const projectsDir = async ($: EngineInterface) =>
  `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`}/projects`

// A session's own transcript and its subagents', in the project folder `dir`.
async function sessionFiles($: EngineInterface, dir: string, sid: string, size: number): Promise<TranscriptFile[]> {
  const files = [{ path: `${dir}/${sid}.jsonl`, size }]
  const subagents = `${dir}/${sid}/subagents`
  if (await $.fs.exists(subagents)) {
    for (const entry of await $.fs.list(subagents)) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) files.push({ path: `${subagents}/${entry.name}`, size: entry.size })
    }
  }
  return files
}

async function transcriptFiles($: EngineInterface, sid: string): Promise<TranscriptFile[] | undefined> {
  const projects = await projectsDir($)
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
  return sessionFiles($, dir, sid, (await $.fs.stat(`${dir}/${sid}.jsonl`)).size)
}

// A transcript's requests, priced, by day.
function daysOf(turns: Iterable<Turn>, sessionModel: string, settings: Settings, now: number, project?: string) {
  const days: Record<string, DayRecord> = {}
  const byModel: Record<string, Tally> = {}
  for (const turn of turns) {
    const cost = costOf(turn.model, turn.usage, scopeFor(turn.model, sessionModel), settings.premiumPct)
    const date = dateOf(Number.isFinite(turn.at) ? turn.at : now)
    byModel[rowOf(turn.model)] = add(byModel[rowOf(turn.model)] ?? ZERO, turn.usage, cost)
    days[date] = addDay(days[date], turn.model, turn.usage, cost, project ?? turn.cwd)
  }
  return { days, byModel }
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

  const project = await $.session.root()
  let byModel: Record<string, Tally> = {}
  let days: Record<string, DayRecord> = {}
  if (isRead) {
    // The transcript holds every request: each day of this session is rebuilt from it.
    for (const key of ownKeys) await $.store.delete(key)
    ;({ days, byModel } = daysOf(turns.values(), sessionModel, settings, now, project))
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
        days[today] = { ...tally, models: { [EARLIER]: tally }, project }
      }
    }
  }

  await update($, meter, () => ({ byModel, isWarned: false, isBackfilled: true }))
  await writeDays($, sid, days)
}

// Seeds the history from every transcript Claude Code still keeps (it deletes
// them after `cleanupPeriodDays`, 30 by default), this session's aside: the
// backfill counts that one. A transcript rebuilds its session's recent days,
// as the backfill does, and adds its older days to the history where the
// session is not in it yet. Other sessions are priced at this session's kind
// of inference profile: the transcript does not name theirs.
async function seed($: EngineInterface, settings: Settings) {
  const sid = await $.session.id()
  const sessionModel = await $.session.model()
  const projects = await projectsDir($)
  const sessions: { dir: string; sid: string; size: number }[] = []
  if (await $.fs.exists(projects)) {
    for (const folder of await $.fs.list(projects)) {
      if (folder.kind !== 'dir') continue
      const dir = `${projects}/${folder.name}`
      for (const entry of await $.fs.list(dir)) {
        const name = entry.name.replace(/\.jsonl$/, '')
        if (entry.kind === 'file' && name !== entry.name && name !== sid) sessions.push({ dir, sid: name, size: entry.size })
      }
    }
  }
  await update($, scan, () => ({ isRunning: true, done: 0, files: sessions.length }))
  const keys = await $.store.keys()
  let counted = 0
  for (const [i, one] of sessions.entries()) {
    const turns = new Map<string, Turn>()
    try {
      for (const file of await sessionFiles($, one.dir, one.sid, one.size)) await readTranscript($, file, turns)
    } catch {
      continue // unreadable now: a rescan tries it again
    } finally {
      await update($, scan, s => ({ ...s, done: i + 1 }))
    }
    if (turns.size === 0) continue
    const { days } = daysOf(turns.values(), sessionModel, settings, await $.clock.now())
    for (const key of keys) if (key.startsWith('day:') && key.endsWith(`:${one.sid}`)) await $.store.delete(key)
    await writeDays($, one.sid, days)
    counted++
  }
  const at = await $.clock.now()
  await $.store.set(SEEDED, { at, sessions: counted })
  await update($, scan, () => ({ isRunning: false, done: sessions.length, files: sessions.length, at, sessions: counted }))
  await refreshToday($)
}

let scanning: Promise<void> | undefined // one scan at a time

async function runScan($: EngineInterface, settings: Settings) {
  scanning ??= seed($, settings)
    .catch(async (err: unknown) => {
      const error = String((err as Error)?.message ?? err)
      await update($, scan, s => ({ ...s, isRunning: false, error })).catch(() => {}) // the session may be gone
    })
    .finally(() => {
      scanning = undefined
    })
  return scanning
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Bedrock meter', focus: true, closeOnEscape: true })

// The band order file, as hamzafer's claude-code-mods checklist saves it; [] on any error.
async function readBandOrder($: EngineInterface): Promise<string[]> {
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    premiumPct: Number(options.regionalPremiumPct ?? 10),
    budgetUsd: Number(options.budgetUsd ?? 0),
    monthBudgetUsd: Number(options.monthBudgetUsd ?? 0),
  }
  let lastModel = ''
  let timer: Timer | undefined
  let bandOrder: Promise<string[]> | undefined // read once per load

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'bedrock-cost',
      description: 'Bedrock cost in a pane: this session by model, or `history` for totals, histograms and breakdowns',
      argumentHint: '[history | rescan | export [file]]',
    })
    void $.ui.close({ id: OLD_HISTORY }).catch(() => {})
    $.ui.status(undefined) // the band took over from the status line of the first version
    await rollUp($)
    await backfill($, settings)
    await refreshToday($)
    await checkMonthBudget($, settings)
    const seeded = (await $.store.get(SEEDED)) as { at: number; sessions: number } | undefined
    if (seeded) await update($, scan, s => (s.isRunning ? s : { ...s, at: seeded.at, sessions: seeded.sessions }))
    else void runScan($, settings)
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

  on('command.run', { command: 'bedrock-cost' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'history') {
      await update($, view, v => ({ ...v, tab: 'overview' as const }))
      const opened = await openPane($)
      const line = 'Bedrock history: o overview · h histogram (d/w/m) · b breakdown (e/p/s) · c session · r range · Esc closes.'
      return { text: opened.isPlaced ? line : `${line} Widen the terminal to see the pane.` }
    }
    if (verb === 'rescan') {
      await runScan($, settings)
      const s = await read($, scan)
      return { text: s.error ? `Transcript scan failed: ${s.error}` : `Read ${s.files} old transcripts; ${s.sessions ?? 0} had Bedrock requests.` }
    }
    if (verb === 'export') {
      const home = await $.env.get('HOME')
      const file = rest.join(' ').replace(/^~(?=\/|$)/, home ?? '~') || `${home}/bedrock-meter-history.csv`
      const sessionsFile = file.replace(/(\.csv)?$/, '-sessions.csv')
      const { models, sessions } = toCsv(await loadDays($))
      await $.fs.write(file, models)
      await $.fs.write(sessionsFile, sessions)
      return { text: `Wrote ${file} (per day and model) and ${sessionsFile} (per day and session).` }
    }
    if (verb !== '') return { text: `Unknown: /bedrock-cost ${verb}. Try /bedrock-cost, /bedrock-cost history, rescan or export [file].` }
    await update($, view, v => ({ ...v, tab: 'session' as const }))
    const opened = await openPane($)
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

  // One pane, its tabs the session and the history: opened by the command,
  // closed by Esc, as /usage is.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    const m = await read($, meter)
    return drawPane($.ui.resolve(e), {
      session: {
        byModel: m.byModel,
        today: await read($, todayTally), // a new request redraws the pane
        month: await read($, monthTally),
        context: await read($, context),
        engineUsd: (await $.session.usage()).cost?.usd,
        published: PUBLISHED.slice(0, 10),
        budgetUsd: settings.budgetUsd,
      },
      days: await loadDays($),
      today: dateOf(now),
      now,
      view: await read($, view),
      scan: await read($, scan),
      monthBudgetUsd: settings.monthBudgetUsd,
      columns: e.props.bodyColumns,
      home: await $.env.get('HOME'),
      onView: patch => void update($, view, v => ({ ...v, ...patch })),
    })
  })
}
