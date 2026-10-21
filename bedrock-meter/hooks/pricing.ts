// USD per million tokens at Bedrock's global (base) on-demand rates.
// Cache writes are priced at 1.25x input (the 5-minute TTL Claude Code uses).
// Check https://aws.amazon.com/bedrock/pricing/ and edit here when rates move.
export type Price = { input: number; output: number; cacheRead: number }

type Row = { family: string; price: Price; long?: Price }

// Longest family first, so `opus-5-5` wins over `opus-5`.
const ROWS: Row[] = [
  { family: 'fable-5-1', price: { input: 10, output: 50, cacheRead: 0.25 } },
  { family: 'mythos-5-1', price: { input: 10, output: 50, cacheRead: 0.25 } },
  { family: 'fable-5', price: { input: 10, output: 50, cacheRead: 1 } },
  { family: 'mythos-5', price: { input: 10, output: 50, cacheRead: 1 } },
  { family: 'opus-5-5', price: { input: 4, output: 20, cacheRead: 0.2 } },
  { family: 'opus-5', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { family: 'opus-4-8', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { family: 'opus-4-7', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { family: 'opus-4-6', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { family: 'opus-4-5', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { family: 'opus-4-1', price: { input: 15, output: 75, cacheRead: 1.5 } },
  { family: 'opus-4', price: { input: 15, output: 75, cacheRead: 1.5 } },
  { family: 'sonnet-5-5', price: { input: 2, output: 10, cacheRead: 0.2 } },
  { family: 'sonnet-5', price: { input: 2, output: 10, cacheRead: 0.2 } },
  { family: 'sonnet-4-6', price: { input: 3, output: 15, cacheRead: 0.3 } },
  { family: 'sonnet-4-5', price: { input: 3, output: 15, cacheRead: 0.3 } },
  { family: 'sonnet-4', price: { input: 3, output: 15, cacheRead: 0.3 } },
  { family: '3-7-sonnet', price: { input: 3, output: 15, cacheRead: 0.3 } },
  {
    family: 'haiku-5-5',
    price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    long: { input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  { family: 'haiku-4-5', price: { input: 1, output: 5, cacheRead: 0.1 } },
  { family: '3-5-haiku', price: { input: 0.8, output: 4, cacheRead: 0.08 } },
]

// Haiku 5.5 bills prompts over this many tokens at its `long` rates.
const LONG_PROMPT = 100_000
const CACHE_WRITE = 1.25

// `us.anthropic.claude-opus-5-5`, `anthropic.claude-sonnet-4-5-20250929-v1:0`,
// an inference-profile ARN: all name the family after `claude-`.
export const familyOf = (model: string): string | undefined => {
  const id = model.toLowerCase()
  return ROWS.find(row => {
    const name = `claude-${row.family}`
    const at = id.indexOf(name)
    return at >= 0 && !/[a-z0-9]/.test(id[at + name.length] ?? '')
  })?.family
}

export const isGlobal = (model: string) => /(^|\/)global\./.test(model)

// The transcript names models bare (`claude-opus-5-5`); the session's own
// model id then says which kind of inference profile served them.
export const premiumFor = (model: string, sessionModel: string, pct: number) => {
  const isNamed = /anthropic\./.test(model) || model.startsWith('arn:')
  return isGlobal(isNamed ? model : sessionModel) ? 0 : pct
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The request's cost in USD, or undefined for a model the table lacks.
export const costOf = (model: string, u: Usage, premiumPct = 0): number | undefined => {
  const family = familyOf(model)
  const row = ROWS.find(one => one.family === family)
  if (!row) return undefined
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const p = row.long && prompt > LONG_PROMPT ? row.long : row.price
  const usd =
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * CACHE_WRITE +
      u.cache_read_input_tokens * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000
  return usd * (1 + premiumPct / 100)
}
