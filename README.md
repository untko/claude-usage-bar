# usage-bar

A Claude Code mod: an always-visible band above the prompt showing context fill, plan rate
limits (5h, 7d), the last turn's tokens, duration and cost, its skills, a per-turn sparkline
(hover a bar for that turn's figures, end time and cost), and a copy mark that copies the session id.

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

## Developing

- Run the tests from the marketplace folder (`plugins/`), not from inside this folder: `claude plugin test usage-bar`.
- This folder is its own git repo (`untko/claude-usage-bar`, branch `main`); the marketplace folder above it is not. Do not commit `.superpowers/friction.jsonl`, an auto-written log.
- Keep the version below 1.0.0 (0.9.9, then 0.9.10, and so on). Bump it in `plugin.json` and in the marketplace entry together.
- A new version loads only after the app is fully quit and reopened; `/reload-plugins` keeps the old one.
- On macOS, `sed -i` needs an empty suffix argument: `sed -i ''`.

### Width rules

The desktop wraps text that overflows the band instead of cutting it, so every optional part must fit whole or be dropped.

- `LAYOUTS` lists the layouts from richest to leanest; the first one that fits wins. A part is dropped in this order: `full in`, the last turn's figures, the sparkline from 5 bars to 3, then the band takes two rows.
- Width is an estimate that runs a few cells optimistic (`GLYPH_WIDTH` for the desktop's narrower glyphs), so `EDGE_MARGIN` and `FULL_IN_MARGIN` keep spare cells. A part at the end of the row needs the largest margin.
- Changing the width of any part shifts the width thresholds in several tests; retune them by probing, not by guessing.
