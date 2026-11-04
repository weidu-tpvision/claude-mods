export type Tally = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  isPriced: boolean
}

// `isBackfilled`: the requests before the mod loaded are counted, from the
// session's transcript or, failing that, Claude Code's own estimate.
export type Meter = { byModel: Record<string, Tally>; isWarned: boolean; isBackfilled: boolean }

// The live context window, as `session.measure` last reported it.
export type Context = { tokens?: number; window: number; percent?: number }

// One session's day (`day:<date>:<session>`): its totals, and from 0.4 on, by
// model and with the project folder it ran in.
export type DayRecord = Tally & { models?: Record<string, Tally>; project?: string }

// One day of every session (`hist:<date>`), rolled up once it is older than
// the 31 days kept per session. `sessions` says who is counted in it already.
export type HistDay = {
  total: Tally
  models: Record<string, Tally>
  sessions: Record<string, { usd: number; project?: string }>
}

export type HistoryTab = 'overview' | 'chart' | 'breakdown'
export type ChartStep = 'day' | 'week' | 'month'
export type BreakdownBy = 'model' | 'project' | 'session'
export type Range = 'all' | 'month'

// What the history pane shows.
export type HistoryView = { tab: HistoryTab; chart: ChartStep; by: BreakdownBy; range: Range }

// The scan of old transcripts that seeds the history.
export type Scan = { isRunning: boolean; done: number; files: number; at?: number; sessions?: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'bedrock-meter': {
      meter: Meter
      context: Context | null
      today: Tally
      month: Tally
      view: HistoryView
      scan: Scan
    }
  }
}
