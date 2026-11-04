import type { Tally } from '../types'
import type { Usage } from './pricing'

export const ZERO: Tally = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, isPriced: true }

export const add = (t: Tally, u: Usage, cost: number | undefined): Tally => ({
  requests: t.requests + 1,
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  usd: t.usd + (cost ?? 0),
  isPriced: t.isPriced && cost !== undefined,
})

export const sum = (tallies: Tally[]): Tally =>
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

// The counting fields alone, so a record's extras never ride into a sum.
export const plain = (t: Tally): Tally => sum([t])

const pad = (n: number) => String(n).padStart(2, '0')

// The local calendar day, so "today" turns over at the person's midnight.
export const dateOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// A `YYYY-MM-DD` date as local midnight.
export const parseDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

// The date `n` days after `date` (before, for a negative n), by the calendar.
export const shiftDate = (date: string, n: number) => {
  const d = parseDate(date)
  return dateOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime())
}

// The Monday of `date`'s week.
export const weekOf = (date: string) => shiftDate(date, -((parseDate(date).getDay() + 6) % 7))

// The first day of the month `n` months from `date`'s.
export const monthFrom = (date: string, n: number) => {
  const d = parseDate(date)
  return dateOf(new Date(d.getFullYear(), d.getMonth() + n, 1).getTime())
}
