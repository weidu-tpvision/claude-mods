# bedrock-meter

A token and cost meter for Claude Code on Amazon Bedrock (pay per token, no subscription).

- **Band above the prompt:** session cost, a context bar (green, yellow from 75%, red from 90%), input/output tokens, cache reads and hit rate, and today's total. On a narrow terminal it drops the token counts first, then the cache figure, then the bar and today's total, so it stays on one line. With a budget set, the cost turns yellow at 70% of it and red once passed.
- **Next to other band mods:** it stacks with hamzafer's [claude-code-mods](https://github.com/hamzafer/claude-code-mods) bands (context-bar, token-weather, ...) through their shared `hooks/bands.ts` (MIT), in the order their checklist saves.
- **`/bedrock-cost`:** opens a pane with a per-model breakdown and the session and daily totals, next to Claude Code's own `/cost` estimate.
- **Pricing:** AWS's own on-demand rates, global and regional, in `hooks/prices.ts`, generated from the AWS price list (us-east-1) by `.github/scripts/bedrock_prices.py`. A `global.` profile bills the global rates; in-region and geo profiles (`us.`, `eu.`, ...) the regional ones, which AWS sets about 10% higher for most current models and not at all for some. Cache writes bill at AWS's 5-minute cache-write rate, the TTL Claude Code uses by default; requests that write the 1-hour cache are underestimated. A weekly workflow reruns the script and opens a pull request when a price moves.
- **Options** (`/config`): a fallback regional premium % (for a model listed with global prices only), a session budget that shows a toast when it is passed, and whether the pane opens when a session starts.

Every model request is counted, including subagents and compaction. Requests made before the mod loaded (or before a resume) are read back from the session transcript. For `global.` profiles the session cost matches Claude Code's own `/cost`, which prices at the global rates; for regional ones it comes out higher by AWS's regional surcharge. Daily totals carry across sessions, by local calendar day, and are kept for 31 days. `/clear` resets the session meter.

Costs are estimates from the price table (the pane says which AWS list it is from); your AWS bill is the final word.

## Updating the prices by hand

```
python3 .github/scripts/bedrock_prices.py
```

From the repository's root: it fetches the AWS price list, rewrites `bedrock-meter/hooks/prices.ts` and bumps the mod's patch version when a price changed. Or edit a row of `prices.ts` directly (USD per million tokens). Then run `claude plugin test bedrock-meter`, commit and push.

## Install

At the prompt of a Claude Code terminal session (tested with Claude Code 2.1.306):

```
/plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods`.
