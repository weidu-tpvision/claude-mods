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

declare module 'claude-code' {
  interface PluginState {
    'bedrock-meter': { meter: Meter; context: Context | null; today: Tally }
  }
}
