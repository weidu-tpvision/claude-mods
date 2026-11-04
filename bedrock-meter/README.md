# bedrock-meter

A token and cost meter for Claude Code on Amazon Bedrock (pay per token, no subscription).

The band above the prompt, on a wide terminal, about 80 columns, and a narrow one (example figures):

```
Bedrock $4.37 · ctx █▄▁▁▁▁▁▁ 18% 182.4k/1.0M · in 412.6k out 58.3k · cache 6.1M 94% · today $11.82 · month $163
Bedrock $4.37 · ctx █▄▁▁▁▁▁▁ 18% · cache 6.1M 94% · today $11.82 · month $163
$4.37 · ctx ▇▁▁▁▁ 18% · today $11.82 · month $163
```

- **Band above the prompt:** session cost, a context bar (green, yellow from 75%, red from 90%), input/output tokens, cache reads and hit rate, today's total and this month's. On a narrow terminal it drops the token counts first, then the context's token figures (its percent stays), then the cache figure, then the labels and the month's total, and last the bar and today's total, so it stays on one line. With a budget set, the cost turns yellow at 70% of it and red once passed.
- **Next to other band mods:** it stacks with hamzafer's [claude-code-mods](https://github.com/hamzafer/claude-code-mods) bands (context-bar, token-weather, ...) through their shared `hooks/bands.ts` (MIT), in the order their checklist saves.
- **`/bedrock-cost`:** opens the pane, for what the band has no room for. It takes the keyboard, as `/usage` does, and Esc closes it. `/bedrock-cost` opens it on the session, `/bedrock-cost history` on the overview; the keys move between its tabs.
  - **c Session:** this session by model (cost, requests, input, cache write, cache read and output tokens), its total and cache hit rate, today's and the month's totals, the context, and Claude Code's own `/cost` estimate beside them.
  - **o Overview:** all time (since the first day on record), this year, last month, this month with a month-end projection at its pace so far, this week, today, the average per active day; where the money went by token kind (input, cache write, cache read, output); what the cache saved; the hit rate of the last 8 weeks; the regional surcharge paid over the `global.` rates.
  - **h Histogram:** a bar per day (last 30), week (last 12, from Monday) or month (last 12): keys d, w, m.
  - **b Breakdown:** by model, by project folder, or the top 15 sessions: keys e, p, s.
  - **r** switches the overview's split and the breakdown between all time and this month.
- **`/bedrock-cost rescan`** reads the old transcripts again; **`/bedrock-cost export [file]`** writes the history as CSV, a row per day and model (default `~/bedrock-meter-history.csv`) and, beside it, a row per day and session (`…-sessions.csv`).
- **Pricing:** AWS's own on-demand rates, global and regional, in `hooks/prices.ts`, generated from the AWS price list (us-east-1) by `.github/scripts/bedrock_prices.py`. A `global.` profile bills the global rates; in-region and geo profiles (`us.`, `eu.`, ...) the regional ones, which AWS sets about 10% higher for most current models and not at all for some. Cache writes bill at AWS's 5-minute cache-write rate, the TTL Claude Code uses by default; requests that write the 1-hour cache are underestimated. A weekly workflow reruns the script and opens a pull request when a price moves.
- **Options** (`/config`): a fallback regional premium % (for a model listed with global prices only), a session budget that shows a toast when it is passed, and a monthly budget that does the same for the calendar month (every session's) and shows in the pane's overview.

Every model request is counted, including subagents and compaction. Requests made before the mod loaded, or in a resumed session's earlier runs, are read back from the session transcript, however long it is (one over 4 MiB is streamed through `cat`). Claude Code's `<synthetic>` placeholders for requests that never got a response are skipped. For `global.` profiles the session cost matches Claude Code's own `/cost` and `/usage`, which price at the global rates and, since 2.1.318, also count a resumed session from its first launch. For regional profiles it comes out higher by AWS's regional surcharge. `/clear` resets the session meter.

**Today** adds up every session's requests made on the current local calendar day. A session resumed on a later day adds only that day's requests; its earlier ones stay on their own dates. **Month** adds up the days of the current local calendar month, across all sessions, the same way. Daily totals are kept per session for 31 days, enough to cover any month; after that each day's sessions are rolled up into one record for the day, with its totals by model and each session's spend and project folder, kept for good (a few hundred bytes a day of the mod's 4 MiB store).

**History** starts, the first time 0.4 loads, with a scan in the background of every transcript Claude Code still keeps, in every project. Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default), so the history reaches back only that far; raise it in `settings.json` to keep more for a rescan. Those older sessions are priced at the current session's kind of inference profile (global or regional), as their transcripts do not say which they used. Days counted before 0.4 whose transcript is gone keep their totals without a model or project. If the transcript can't be read, the session cost falls back to Claude Code's own total. That total has no dates, so it goes on today only when the session began today; otherwise the days keep what the meter counted live.

Costs are estimates from the price table (the pane says which AWS list it is from); your AWS bill is the final word.

## Updating the prices by hand

```
python3 .github/scripts/bedrock_prices.py
```

From the repository's root: it fetches the AWS price list, rewrites `bedrock-meter/hooks/prices.ts` and bumps the mod's patch version when a price changed. Or edit a row of `prices.ts` directly (USD per million tokens). Then run `claude plugin test bedrock-meter`, commit and push.

## Install

At the prompt of a Claude Code terminal session (tested with Claude Code 2.1.318):

```
/plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods`.
