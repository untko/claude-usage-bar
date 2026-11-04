# usage-bar

A Claude Code mod: an always-visible band above the prompt showing context fill, plan rate
limits (5h, 7d), the last turn's tokens and duration, its skills, a per-turn sparkline
(hover a bar for that turn's figures, end time and cost), and the short session id.

## Layout

- `hooks/register.tsx` — the mod (band, layouts, turn accounting)
- `hooks/register.test.ts` — tests, run with `claude plugin test usage-bar`
- `types/index.d.ts` — plugin state types
- `.claude-plugin/plugin.json` — manifest (bump `version` on every change)

## Install from a local marketplace

Put this folder beside a `.claude-plugin/marketplace.json` that lists it with `"source": "./usage-bar"`, then:

```bash
claude plugin marketplace add <marketplace-folder>
claude plugin install usage-bar@<marketplace-name>
```

Updates: bump the version in `plugin.json` and the marketplace entry, run `claude plugin validate`,
`claude plugin test`, `claude plugin marketplace update`, `claude plugin update`, then fully quit the app.
