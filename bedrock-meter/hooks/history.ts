import type { EngineInterface } from 'claude-code'

import type { DayRecord, HistDay, Tally } from '../types'
import { rowFor } from './pricing'
import { monthFrom, plain, shiftDate, sum, weekOf, ZERO } from './tally'

// Days counted before 0.4 carry no model.
export const NO_MODEL = 'model not recorded'
export const NO_PROJECT = 'project not recorded'

export type Day = HistDay & { date: string }

export const DAY_KEY = /^day:(\d{4}-\d\d-\d\d)(?::(.+))?$/
const HIST_KEY = /^hist:(\d{4}-\d\d-\d\d)$/
export const histKey = (date: string) => `hist:${date}`

export const emptyHist = (): HistDay => ({ total: ZERO, models: {}, sessions: {} })

const addModels = (into: Record<string, Tally>, from: Record<string, Tally>) => {
  const out = { ...into }
  for (const [model, t] of Object.entries(from)) out[model] = sum([out[model] ?? ZERO, t])
  return out
}

export const modelsOf = (r: DayRecord): Record<string, Tally> => r.models ?? { [NO_MODEL]: plain(r) }

// One session's day added to a day of history; a session already in it stays
// as it was, so rolling up or rescanning twice never counts it twice.
export function mergeSession(h: HistDay, sid: string, r: DayRecord): HistDay {
  if (h.sessions[sid]) return h
  const session = r.project === undefined ? { usd: r.usd } : { usd: r.usd, project: r.project }
  return {
    total: sum([h.total, plain(r)]),
    models: addModels(h.models, modelsOf(r)),
    sessions: { ...h.sessions, [sid]: session },
  }
}

const mergeHist = (a: HistDay, b: HistDay): HistDay => ({
  total: sum([a.total, b.total]),
  models: addModels(a.models, b.models),
  sessions: { ...a.sessions, ...b.sessions },
})

// Every day on record, oldest first: the rolled-up days and the recent
// per-session ones together.
export async function loadDays($: EngineInterface): Promise<Day[]> {
  const byDate = new Map<string, HistDay>()
  for (const key of await $.store.keys()) {
    const day = DAY_KEY.exec(key)
    const hist = HIST_KEY.exec(key)
    if (day?.[2] !== undefined) {
      const r = (await $.store.get(key)) as DayRecord | undefined
      if (r) byDate.set(day[1]!, mergeSession(byDate.get(day[1]!) ?? emptyHist(), day[2], r))
    } else if (hist) {
      const h = (await $.store.get(key)) as HistDay | undefined
      if (h) byDate.set(hist[1]!, mergeHist(byDate.get(hist[1]!) ?? emptyHist(), h))
    }
  }
  return [...byDate].map(([date, h]) => ({ date, ...h })).sort((a, b) => (a.date < b.date ? -1 : 1))
}

// The days from `from` to `to`, both included, as one.
export function span(days: Day[], from: string, to: string): HistDay {
  return days.filter(d => d.date >= from && d.date <= to).reduce(mergeHistKeepSessions, emptyHist())
}

// Sessions spanning days keep their full spend, summed over the days.
function mergeHistKeepSessions(a: HistDay, b: HistDay): HistDay {
  const sessions = { ...a.sessions }
  for (const [sid, s] of Object.entries(b.sessions)) {
    sessions[sid] = { usd: (sessions[sid]?.usd ?? 0) + s.usd, project: sessions[sid]?.project ?? s.project }
  }
  return { total: sum([a.total, b.total]), models: addModels(a.models, b.models), sessions }
}

export type Bucket = { start: string; usd: number; isCurrent: boolean }

// `count` buckets of a day, a week (from Monday) or a calendar month, the
// current one last.
export function buckets(days: Day[], today: string, step: 'day' | 'week' | 'month', count: number): Bucket[] {
  const keyOf = (date: string) => (step === 'day' ? date : step === 'week' ? weekOf(date) : date.slice(0, 7) + '-01')
  const current = keyOf(today)
  const starts: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    starts.push(step === 'day' ? shiftDate(current, -i) : step === 'week' ? shiftDate(current, -7 * i) : monthFrom(current, -i))
  }
  const usd = new Map(starts.map(s => [s, 0]))
  for (const d of days) {
    const key = keyOf(d.date)
    if (usd.has(key)) usd.set(key, usd.get(key)! + d.total.usd)
  }
  return starts.map(start => ({ start, usd: usd.get(start)!, isCurrent: start === current }))
}

// Where the money went, in USD: the token kinds, priced at the table's
// rates and scaled to what was counted, so a regional session's surcharge is
// shared out among them. `saved`: what the cache reads would have cost as
// fresh input, less what they did; `premium`: the regional surcharge over the
// global rates. `unsplit`: spend on models the table lacks.
export type Split = {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  saved: number
  premium: number
  unsplit: number
}

export function splitOf(models: Record<string, Tally>): Split {
  const out: Split = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, saved: 0, premium: 0, unsplit: 0 }
  for (const [model, t] of Object.entries(models)) {
    const row = rowFor(model)
    const p = row?.global ?? row?.regional
    const parts = p && {
      input: t.input * p.input,
      cacheWrite: t.cacheWrite * p.cacheWrite,
      cacheRead: t.cacheRead * p.cacheRead,
      output: t.output * p.output,
    }
    const listed = parts ? (parts.input + parts.cacheWrite + parts.cacheRead + parts.output) / 1e6 : 0
    if (!p || !parts || listed === 0) {
      out.unsplit += t.usd
      continue
    }
    const k = t.usd / listed
    out.input += (parts.input / 1e6) * k
    out.cacheWrite += (parts.cacheWrite / 1e6) * k
    out.cacheRead += (parts.cacheRead / 1e6) * k
    out.output += (parts.output / 1e6) * k
    out.saved += ((t.cacheRead * (p.input - p.cacheRead)) / 1e6) * k
    if (row?.global) out.premium += Math.max(0, t.usd - listed)
  }
  return out
}

const csvCell = (v: string | number) => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const csv = (rows: (string | number)[][]) => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'

// A row per day and model, and a row per day and session.
export function toCsv(days: Day[]) {
  const byModel: (string | number)[][] = [['date', 'model', 'requests', 'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'usd']]
  const bySession: (string | number)[][] = [['date', 'session', 'project', 'usd']]
  for (const d of days) {
    for (const [model, t] of Object.entries(d.models)) byModel.push([d.date, model, t.requests, t.input, t.cacheWrite, t.cacheRead, t.output, t.usd])
    for (const [sid, s] of Object.entries(d.sessions)) bySession.push([d.date, sid, s.project ?? '', s.usd])
  }
  return { models: csv(byModel), sessions: csv(bySession) }
}
