# claude-mods

Mods for [Claude Code](https://claude.com/claude-code) (2.1.287 or later): hooks modules that add to Claude Code's own interface.

| Mod | What it does |
| --- | --- |
| [bedrock-meter](bedrock-meter) | Token and USD meter for pay-per-token Amazon Bedrock sessions: a band above the prompt with cost, context fill, cache hit rate and today's total; `/bedrock-cost` for a per-model pane. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user, to have it in every session).

From a shell:

```
claude plugin install bedrock-meter --marketplace weidu-tpvision/claude-mods
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `weidu-tpvision/claude-mods`, then Add plugin.

## License

MIT. See [LICENSE](LICENSE) and, for code taken from other projects, [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
