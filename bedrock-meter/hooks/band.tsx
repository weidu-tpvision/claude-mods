import type { Elements } from 'claude-code'

import type { Context, Tally } from '../types'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text'>

export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`
export const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`)

// Share of the prompt the cache served: the figure that drives the bill most.
export const hitRate = (t: Tally) => {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt === 0 ? 0 : Math.round((t.cacheRead / prompt) * 100)
}

export type Figures = { total: Tally; today: Tally; budgetUsd: number; context: Context | null }

type Segment = { text: string; color?: string; dim?: boolean; bold?: boolean }

type Layout = { isLong: boolean; cells: number; hasTokens: boolean; hasCache: boolean; hasToday: boolean }

// Widest first: the band sheds token counts, then the cache figure and the
// labels, then the bar and today's total, so it keeps to one line.
const LAYOUTS: Layout[] = [
  { isLong: true, cells: 8, hasTokens: true, hasCache: true, hasToday: true },
  { isLong: true, cells: 8, hasTokens: false, hasCache: true, hasToday: true },
  { isLong: false, cells: 5, hasTokens: false, hasCache: false, hasToday: true },
  { isLong: false, cells: 0, hasTokens: false, hasCache: false, hasToday: false },
]

const SPLIT = ' · '
const BLOCKS = '▁▂▃▄▅▆▇█'

// Context fill: green, yellow from 75%, red from 90%, as usage-meter colors its windows.
export const colorFor = (percent: number) => (percent >= 90 ? 'red' : percent >= 75 ? 'yellow' : 'green')

// Spend against the budget: plain under 70%, yellow from there, red once passed.
export const budgetColor = (usdSpent: number, budgetUsd: number) => {
  if (budgetUsd <= 0) return undefined
  const share = usdSpent / budgetUsd
  return share >= 1 ? 'red' : share >= 0.7 ? 'yellow' : undefined
}

// Eighth blocks, so a few cells still move with each percent.
export function bar(percent: number, cells: number) {
  const filled = (Math.min(Math.max(percent, 0), 100) / 100) * cells
  let out = ''
  for (let i = 0; i < cells; i++) {
    out += BLOCKS[Math.round(Math.min(Math.max(filled - i, 0), 1) * (BLOCKS.length - 1))]
  }
  return out
}

function parts(f: Figures, l: Layout): Segment[][] {
  const out: Segment[][] = []
  const { total, context } = f

  if (total.requests > 0 || total.usd > 0) {
    const color = budgetColor(total.usd, f.budgetUsd)
    out.push([
      { text: l.isLong ? 'Bedrock ' : '', dim: true },
      { text: `${usd(total.usd)}${total.isPriced ? '' : '+'}`, color, bold: color !== undefined },
      { text: l.isLong && f.budgetUsd > 0 ? ` of ${usd(f.budgetUsd)}` : '', dim: true },
    ])
  }

  if (context?.percent !== undefined) {
    const color = colorFor(context.percent)
    out.push([
      { text: 'ctx ', dim: true },
      { text: l.cells > 0 ? `${bar(context.percent, l.cells)} ` : '', color },
      { text: `${Math.round(context.percent)}%`, color },
      {
        text: l.isLong && context.tokens !== undefined ? ` ${tokens(context.tokens)}/${tokens(context.window)}` : '',
        dim: true,
      },
    ])
  }

  if (total.requests > 0 || total.usd > 0) {
    if (l.hasTokens) out.push([{ text: `in ${tokens(total.input + total.cacheWrite)} out ${tokens(total.output)}`, dim: true }])
    if (l.hasCache) out.push([{ text: 'cache ', dim: true }, { text: `${tokens(total.cacheRead)} ${hitRate(total)}%` }])
    if (l.hasToday) out.push([{ text: 'today ', dim: true }, { text: usd(f.today.usd) }])
  }
  return out
}

const join = (groups: Segment[][]): Segment[] =>
  groups.flatMap((g, i) => (i > 0 ? [{ text: SPLIT, dim: true }, ...g] : g)).filter(s => s.text !== '')

const widthOf = (segs: Segment[]) => [...segs.map(s => s.text).join('')].length

// The meter at the widest layout that fits `columns`; undefined with nothing to show yet.
export function drawBand(ui: Ui, f: Figures, columns: number) {
  const { Box, Text } = ui
  const fitting = LAYOUTS.map(l => join(parts(f, l))).find(segs => widthOf(segs) <= columns)
  const segs = fitting ?? join(parts(f, LAYOUTS[LAYOUTS.length - 1]!))
  if (segs.length === 0) return undefined

  return (
    <Box flexDirection="row" paddingX={1}>
      {segs.map((s, i) => (
        <Text key={String(i)} color={s.color} dimColor={s.dim} bold={s.bold} wrap="truncate">
          {s.text}
        </Text>
      ))}
    </Box>
  )
}
