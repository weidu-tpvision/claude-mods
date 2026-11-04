import type { Elements } from 'claude-code'

import type { Context, HistDay, HistoryView, Scan, Tally } from '../types'
import { hitRate, tokens, usd } from './band'
import type { Day } from './history'
import { buckets, span, splitOf } from './history'
import { monthFrom, parseDate, shiftDate, sum, weekOf } from './tally'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// The live session, as the meter counts it.
export type SessionFigures = {
  byModel: Record<string, Tally>
  today: Tally
  month: Tally
  context: Context | null
  engineUsd?: number
  published: string
  budgetUsd: number
}

export type HistoryFigures = {
  session: SessionFigures
  days: Day[]
  today: string
  now: number
  view: HistoryView
  scan: Scan
  monthBudgetUsd: number
  columns: number
  home?: string
  onView: (patch: Partial<HistoryView>) => void
}

const EIGHTHS = ' ▏▎▍▌▋▊▉█'
const SPARK = '▁▂▃▄▅▆▇█'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// A horizontal bar of `value` against `max`, in eighth blocks.
export function hbar(value: number, max: number, cells: number) {
  if (max <= 0 || cells <= 0) return ''
  const eighths = Math.round((Math.max(0, value) / max) * cells * 8)
  const full = Math.floor(eighths / 8)
  return '█'.repeat(full) + (eighths % 8 > 0 ? EIGHTHS[eighths % 8] : '')
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
const md = (date: string) => date.slice(5)
const fit = (text: string, width: number) => ([...text].length <= width ? text.padEnd(width) : [...text].slice(0, Math.max(1, width - 1)).join('') + '…')

// A path under the home folder as `~/...`.
const shortPath = (path: string, home?: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

const tallyOf = (h: HistDay) => sum(Object.values(h.models).length > 0 ? Object.values(h.models) : [h.total])

function Tabs(ui: Ui, f: HistoryFigures) {
  const { Box, Text, Button } = ui
  const tab = (key: HistoryView['tab'], hotkey: string, label: string) => (
    <Button key={`tab-${key}`} plain hotkey={hotkey} onPress={() => f.onView({ tab: key })}>
      {f.view.tab === key ? <Text bold>{label}</Text> : <Text dimColor>{label}</Text>}
    </Button>
  )
  return (
    <Box flexDirection="row" gap={2} flexWrap="wrap">
      {tab('session', 'c', 'Session')}
      {tab('overview', 'o', 'Overview')}
      {tab('chart', 'h', 'Histogram')}
      {tab('breakdown', 'b', 'Breakdown')}
    </Box>
  )
}

function Choice<T extends string>(ui: Ui, current: T, pick: (v: T) => void, items: [T, string, string][]) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="row" gap={2} flexWrap="wrap">
      {items.map(([value, hotkey, label]) => (
        <Button key={`pick-${value}`} plain hotkey={hotkey} onPress={() => pick(value)}>
          {current === value ? <Text bold>{label}</Text> : <Text dimColor>{label}</Text>}
        </Button>
      ))}
    </Box>
  )
}

function Session(ui: Ui, f: HistoryFigures) {
  const { Box, Text } = ui
  const s = f.session
  const total = sum(Object.values(s.byModel))
  const rows = Object.entries(s.byModel).sort(([, a], [, b]) => b.usd - a.usd)
  const ctx = s.context
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
              {'  '}in {tokens(t.input)} · write {tokens(t.cacheWrite)} · read {tokens(t.cacheRead)} · out {tokens(t.output)}
            </Text>
          )}
        </Box>
      ))}
      {rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            Session {usd(total.usd)} · cache hit {hitRate(total)}%
          </Text>
          <Text>Today {usd(s.today.usd)} · out {tokens(s.today.output)}</Text>
          <Text>Month {usd(s.month.usd)} · out {tokens(s.month.output)}</Text>
          {ctx?.percent !== undefined && (
            <Text>
              Context {Math.round(ctx.percent)}%{ctx.tokens !== undefined ? ` · ${tokens(ctx.tokens)} of ${tokens(ctx.window)}` : ''}
            </Text>
          )}
          {s.engineUsd !== undefined && <Text dimColor>Claude Code /cost (global rates) {usd(s.engineUsd)}</Text>}
          <Text dimColor>
            Prices: AWS list of {s.published}
            {s.budgetUsd > 0 ? ` · budget ${usd(s.budgetUsd)}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function Overview(ui: Ui, f: HistoryFigures) {
  const { Box, Text } = ui
  const { days, today } = f
  if (days.length === 0) return <Text dimColor>No history yet.</Text>

  const first = days[0]!.date
  const monthStart = today.slice(0, 8) + '01'
  const lastMonthStart = monthFrom(today, -1)
  const all = span(days, first, today)
  const year = span(days, today.slice(0, 4) + '-01-01', today)
  const month = span(days, monthStart, today)
  const lastMonth = span(days, lastMonthStart, shiftDate(monthStart, -1))
  const week = span(days, weekOf(today), today)
  const day = span(days, today, today)
  const active = days.filter(d => d.total.usd > 0).length

  // The month's pace so far, carried to its end.
  const startMs = parseDate(monthStart).getTime()
  const endMs = parseDate(monthFrom(today, 1)).getTime()
  const elapsed = Math.max((f.now - startMs) / (endMs - startMs), 1 / 31)
  const projected = month.total.usd / elapsed

  const lines: [string, string, string?][] = [
    ['All time', usd(all.total.usd), `since ${first} · ${active} active day${active === 1 ? '' : 's'} · avg ${usd(active > 0 ? all.total.usd / active : 0)}/day`],
    ['This year', usd(year.total.usd)],
    ['Last month', usd(lastMonth.total.usd), MONTHS[parseDate(lastMonthStart).getMonth()]],
    ['This month', usd(month.total.usd), `≈ ${usd(projected)} by month end`],
    ['This week', usd(week.total.usd), `since ${WEEKDAYS[1]} ${md(weekOf(today))}`],
    ['Today', usd(day.total.usd)],
  ]

  const split = splitOf(f.view.range === 'month' ? month.models : all.models)
  const spent = (f.view.range === 'month' ? month : all).total.usd
  const kinds = (
    [
      ['cache write', split.cacheWrite],
      ['output', split.output],
      ['cache read', split.cacheRead],
      ['input', split.input],
    ] as const
  )
    .slice()
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => `${name} ${pct(v, spent)}%`)
    .join(' · ')
  const monthSplit = splitOf(month.models)
  const allSplit = splitOf(all.models)

  // The cache hit rate of each of the last 8 weeks.
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const start = shiftDate(weekOf(today), -7 * (7 - i))
    return tallyOf(span(days, start, shiftDate(start, 6)))
  })
  const spark = weeks.map(t => (t.input + t.cacheRead + t.cacheWrite === 0 ? ' ' : SPARK[Math.round((hitRate(t) / 100) * (SPARK.length - 1))])).join('')
  const budget = f.monthBudgetUsd

  return (
    <Box flexDirection="column">
      {lines.map(([label, value, note]) => (
        <Text key={label}>
          {label.padEnd(11)}
          <Text bold>{value.padStart(7)}</Text>
          {note ? <Text dimColor>{`  ${note}`}</Text> : ''}
        </Text>
      ))}
      {budget > 0 && (
        <Text color={month.total.usd >= budget ? 'red' : projected >= budget ? 'yellow' : undefined}>
          {'Budget'.padEnd(11)}
          {`${usd(month.total.usd)} of ${usd(budget)} (${pct(month.total.usd, budget)}%)`}
          {projected >= budget && month.total.usd < budget ? ' · on pace to pass it' : ''}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text dimColor>{f.view.range === 'month' ? 'Where it went this month: ' : 'Where it went: '}</Text>
          {spent > 0 ? kinds : 'nothing yet'}
          {split.unsplit > 0 ? <Text dimColor>{` · ${usd(split.unsplit)} unsplit`}</Text> : ''}
        </Text>
        <Text>
          <Text dimColor>Cache saved ≈ </Text>
          {usd(monthSplit.saved)}
          <Text dimColor> this month, </Text>
          {usd(allSplit.saved)}
          <Text dimColor> all time · hit rate </Text>
          {hitRate(tallyOf(month))}%
          <Text dimColor> this month</Text>
        </Text>
        <Text>
          <Text dimColor>Hit rate, last 8 weeks </Text>
          {spark}
        </Text>
        {allSplit.premium > 0.005 && (
          <Text>
            <Text dimColor>Regional surcharge ≈ </Text>
            {usd(monthSplit.premium)}
            <Text dimColor> this month, </Text>
            {usd(allSplit.premium)}
            <Text dimColor> all time (over global. rates)</Text>
          </Text>
        )}
        {all.total.requests > 0 && (
          <Text dimColor>
            {all.total.requests} requests · {usd(all.total.usd / all.total.requests)} per request on average
          </Text>
        )}
      </Box>
    </Box>
  )
}

const STEPS = { day: 30, week: 12, month: 12 } as const

function Chart(ui: Ui, f: HistoryFigures) {
  const { Box, Text } = ui
  const step = f.view.chart
  const rows = buckets(f.days, f.today, step, STEPS[step])
  const max = Math.max(...rows.map(r => r.usd), 0)
  const label = (start: string) => {
    if (step === 'day') return `${WEEKDAYS[parseDate(start).getDay()]} ${md(start)}`
    if (step === 'week') return `wk ${md(start)}`
    return `${MONTHS[parseDate(start).getMonth()]} ${start.slice(0, 4)}`
  }
  const labelWidth = 8
  const amountWidth = 7
  const cells = Math.max(5, f.columns - labelWidth - amountWidth - 12)
  const total = rows.reduce((all, r) => all + r.usd, 0)
  const unit = step === 'day' ? 'day' : step

  return (
    <Box flexDirection="column">
      {Choice(ui, step, chart => f.onView({ chart }), [['day', 'd', 'Days'], ['week', 'w', 'Weeks'], ['month', 'm', 'Months']])}
      <Box flexDirection="column" marginTop={1}>
        {rows.map(r => (
          <Text key={r.start} wrap="truncate">
            <Text dimColor={!r.isCurrent}>{label(r.start).padEnd(labelWidth)}</Text>
            {usd(r.usd).padStart(amountWidth)}{' '}
            <Text color={r.isCurrent ? 'cyan' : undefined}>{hbar(r.usd, max, cells)}</Text>
            {r.isCurrent ? <Text dimColor> so far</Text> : ''}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        {usd(total)} over these {rows.length} {unit}s · avg {usd(total / rows.length)}/{unit}
      </Text>
    </Box>
  )
}

function Breakdown(ui: Ui, f: HistoryFigures) {
  const { Box, Text } = ui
  const from = f.view.range === 'month' ? f.today.slice(0, 8) + '01' : (f.days[0]?.date ?? f.today)
  const inRange = span(f.days, from, f.today)
  const total = inRange.total.usd

  type Row = { key: string; name: string; usd: number; note?: string }
  let rows: Row[]
  if (f.view.by === 'model') {
    rows = Object.entries(inRange.models).map(([model, t]: [string, Tally]) => ({
      key: model,
      name: model,
      usd: t.usd,
      note: t.requests > 0 ? `${t.requests} req · hit ${hitRate(t)}%` : undefined,
    }))
  } else if (f.view.by === 'project') {
    const byProject = new Map<string, { usd: number; sessions: number }>()
    for (const s of Object.values(inRange.sessions)) {
      const name = s.project ? shortPath(s.project, f.home) : 'project not recorded'
      const one = byProject.get(name) ?? { usd: 0, sessions: 0 }
      byProject.set(name, { usd: one.usd + s.usd, sessions: one.sessions + 1 })
    }
    rows = [...byProject].map(([name, p]) => ({ key: name, name, usd: p.usd, note: `${p.sessions} session${p.sessions === 1 ? '' : 's'}` }))
  } else {
    // Each session's first and last day in the range.
    const dates = new Map<string, [string, string]>()
    for (const d of f.days) {
      if (d.date < from || d.date > f.today) continue
      for (const sid of Object.keys(d.sessions)) {
        const seen = dates.get(sid)
        dates.set(sid, seen ? [seen[0], d.date] : [d.date, d.date])
      }
    }
    rows = Object.entries(inRange.sessions).map(([sid, s]) => {
      const [a, b] = dates.get(sid) ?? ['', '']
      const when = a === b ? md(a) : `${md(a)}→${md(b)}`
      return { key: sid, name: `${when} ${s.project ? shortPath(s.project, f.home) : sid.slice(0, 8)}`, usd: s.usd, note: sid.slice(0, 8) }
    })
  }
  rows.sort((a, b) => b.usd - a.usd)
  const shown = f.view.by === 'session' ? rows.slice(0, 15) : rows
  const max = Math.max(...shown.map(r => r.usd), 0)
  const nameWidth = Math.max(12, Math.min(40, f.columns - 30))

  return (
    <Box flexDirection="column">
      {Choice(ui, f.view.by, by => f.onView({ by }), [['model', 'e', 'Models'], ['project', 'p', 'Projects'], ['session', 's', 'Top sessions']])}
      <Box flexDirection="column" marginTop={1}>
        {shown.length === 0 && <Text dimColor>Nothing in this range.</Text>}
        {shown.map(r => (
          <Box key={r.key} flexDirection="column">
            <Text wrap="truncate">
              {fit(r.name, nameWidth)} <Text bold>{usd(r.usd).padStart(7)}</Text>
              {` ${String(pct(r.usd, total)).padStart(3)}% `}
              <Text color="cyan">{hbar(r.usd, max, 10)}</Text>
            </Text>
            {r.note && <Text dimColor>{`  ${r.note}`}</Text>}
          </Box>
        ))}
        {rows.length > shown.length && <Text dimColor>and {rows.length - shown.length} more</Text>}
      </Box>
    </Box>
  )
}

function ScanLine(ui: Ui, f: HistoryFigures) {
  const { Text } = ui
  const { scan } = f
  if (scan.isRunning) return <Text color="yellow">Reading old transcripts… {scan.done} of {scan.files}</Text>
  if (scan.error) return <Text color="red">Transcript scan failed: {scan.error}</Text>
  return (
    <Text dimColor>
      {scan.at !== undefined ? `Seeded from ${scan.sessions ?? 0} old transcripts. ` : ''}/bedrock-cost rescan · /bedrock-cost export
    </Text>
  )
}

const VIEWS = { session: Session, overview: Overview, chart: Chart, breakdown: Breakdown }

export function drawPane(ui: Ui, f: HistoryFigures) {
  const { Box, Text, Button } = ui
  const body = (VIEWS[f.view.tab] ?? Session)(ui, f)
  const hasRange = f.view.tab === 'overview' || f.view.tab === 'breakdown'
  return (
    <Box flexDirection="column">
      {Tabs(ui, f)}
      <Box flexDirection="column" marginTop={1}>
        {body}
      </Box>
      <Box flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
        {hasRange && (
          <Button key="range" plain hotkey="r" onPress={() => f.onView({ range: f.view.range === 'all' ? 'month' : 'all' })}>
            <Text dimColor>{f.view.range === 'all' ? 'All time' : 'This month'}</Text>
          </Button>
        )}
        {(f.view.tab !== 'session' || f.scan.isRunning) && ScanLine(ui, f)}
      </Box>
    </Box>
  )
}

