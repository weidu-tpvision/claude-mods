import { ROWS } from './prices'

// USD per million tokens. The table is in `prices.ts`, generated from AWS's
// price list by `.github/scripts/bedrock_prices.py`, which a weekly workflow
// runs to propose a change when AWS moves a price.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

// `global` serves global. inference profiles; `regional` in-region and geo
// ones (us., eu., apac.). A model AWS sells in one kind only has that one.
export type Row = { family: string; global?: Price; regional?: Price; globalLong?: Price; regionalLong?: Price }

export type Scope = 'global' | 'regional'

// Prompts over this many tokens bill at a model's `*Long` rates, where it has them.
const LONG_PROMPT: Record<string, number> = { 'haiku-5-5': 100_000 }

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
export const scopeFor = (model: string, sessionModel: string): Scope => {
  const isNamed = /anthropic\./.test(model) || model.startsWith('arn:')
  return isGlobal(isNamed ? model : sessionModel) ? 'global' : 'regional'
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The request's cost in USD, or undefined for a model the table lacks. A
// regional request on a model AWS lists globally alone is priced at the global
// rates plus `premiumPct`, the surcharge AWS puts on the others.
export const costOf = (model: string, u: Usage, scope: Scope = 'global', premiumPct = 0): number | undefined => {
  const row = ROWS.find(one => one.family === familyOf(model))
  if (!row) return undefined
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const isLong = prompt > (LONG_PROMPT[row.family] ?? Infinity)
  const pick = (s: Scope) => (isLong && row[`${s}Long`]) || row[s]
  const p = pick(scope) ?? pick(scope === 'global' ? 'regional' : 'global')
  if (!p) return undefined
  const surcharge = !pick(scope) && scope === 'regional' ? 1 + premiumPct / 100 : 1
  const usd =
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.cacheWrite +
      u.cache_read_input_tokens * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000
  return usd * surcharge
}
