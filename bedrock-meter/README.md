# bedrock-meter

A token and cost meter for Claude Code on Amazon Bedrock (pay per token, no subscription).

- **Band above the prompt:** session cost, a context bar (green, yellow from 75%, red from 90%), input/output tokens, cache reads and hit rate, and today's total. On a narrow terminal it drops the token counts first, then the cache figure, then the bar and today's total, so it stays on one line. With a budget set, the cost turns yellow at 70% of it and red once passed.
- **Next to other band mods:** it stacks with hamzafer's [claude-code-mods](https://github.com/hamzafer/claude-code-mods) bands (context-bar, token-weather, ...) through their shared `hooks/bands.ts` (MIT), in the order their checklist saves.
- **`/bedrock-cost`:** opens a pane with a per-model breakdown and the session and daily totals, next to Claude Code's own `/cost` estimate.
- **Pricing:** Bedrock global on-demand rates, held in `hooks/pricing.ts`. Regional and geo profiles (`us.`, `eu.`, ...) get a configurable premium (10% by default). Cache writes are priced at 1.25x input.
- **Options** (`/config`): regional premium %, a session budget that shows a toast when it is passed, and whether the pane opens when a session starts.

Every model request is counted, including subagents and compaction. Requests made before the mod loaded (or before a resume) are read back from the session transcript, so the meter matches `/usage` apart from the regional premium. Daily totals carry across sessions, by local calendar day, and are kept for 31 days. `/clear` resets the session meter.

Costs are estimates from the rates in `hooks/pricing.ts`, kept by hand: check them against [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/), and your AWS bill is the final word.

## Install

At the prompt of a Claude Code terminal session (Claude Code 2.1.287 or later):

```
/plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods`.
