import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LastTurn, Limit, SkillUse, TurnPoint, Usage } from '../types'

const usage = atom({ plugin: 'usage-bar', key: 'usage' } as const, null)
// The main loop's last finished turn: new tokens (input, output, cache writes) and length.
const lastTurn = atom({ plugin: 'usage-bar', key: 'lastTurn' } as const, null)
// Every finished main-loop turn so far (the whole session, none dropped), for the sparkline,
// and the session's spend at the last of them, so each turn's own dollars are a difference.
const turns = atom({ plugin: 'usage-bar', key: 'turns' } as const, [])
const costMark = atom({ plugin: 'usage-bar', key: 'costMark' } as const, null)
// Every skill expanded during the last finished turn (typed `/name`, the Skill
// tool, a subagent's preload), and those gathering for the turn under way.
const turnSkills = atom({ plugin: 'usage-bar', key: 'turnSkills' } as const, [])
const pendingSkills = atom({ plugin: 'usage-bar', key: 'pendingSkills' } as const, [])

const SKILL_SCOPE = 'usage-bar-skills'
// Bars drawn: five when the band has the width, three when it does not. The whole session's
// history is kept behind them (the hover total sums all of it).
const SPARK_SHOWN = 5
// Bars drawn when the band is short of width (including the two-row layout).
const NARROW_SPARK = 3
// The desktop draws proportional text, so a character takes under nine tenths of the cell the
// app counts it as. Measured on the band: 85 cells spanned 750px (8.8px each) while 46 characters
// of the usage text took 334px (7.3px each), 0.83 of a cell. Counting characters as cells there
// reserves room that stays empty, and the band drops parts or wraps while there is space.
// 0.85 keeps a small margin over the measured figure. The terminal's cells are exact.
const GLYPH_WIDTH: Record<string, number> = { desktop: 0.85 }
// The block glyphs of the sparkline (and the copy mark) are not proportional text: on the desktop each
// takes two of the app's cells. Measured on the band: 5 bars spanned 88px against 7.5px per text
// character, so counting a bar as one character left the copy mark clipped at the band's edge.
const WIDE_GLYPH_CELLS: Record<string, number> = { desktop: 2 }
// A sparkline bar on its own, in the text characters the estimate counts. Measured again on a band with
// the bars side by side: 3 bars took 43px against 8.8px per text character, 1.6 characters a bar, so the
// two cells of a lone wide glyph (the copy mark) overcounted the bars and hid them with room to spare.
const BAR_CHARS: Record<string, number> = { desktop: 1.8 }
// Spare cells a one-row band keeps free while it shows "full in …", so the text never wraps.
const FULL_IN_MARGIN = 6
const BARS = '▁▂▃▄▅▆▇█'
const BASE_DIR = /^Base directory for this skill:\s*(.+)$/m
// Claude Code unpacks its own skills into a temp folder per version; name those instead.
const BUNDLED = /\/bundled-skills\/([^/]+)\//

const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
const parent = (path: string) => path.replace(/\/[^/]+\/?$/, '')

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }
const WINDOW_MIN: Record<string, number> = { five_hour: 300, seven_day: 10080 }

type Part = readonly [text: string, style?: { color?: string; dimColor?: boolean }]
// `spark` is how many turn bars to draw (0 none); `session` the last turn's figures and skills.
// The row is always one tight line, `ctx 66k · 5h 19% ↻54m · 7d 85%▲ ↻2d0h`: the context as
// tokens, single-space separators. `fullIn` keeps each plan's "full in …".
// `brief` trims the last turn to its cost (or its tokens when the ledger has no cost).
// `chip: false` drops the copy mark; `resets: false` the plans' reset timers (`↻3h41m`).
type Layout = { session: boolean; spark: number; fullIn?: boolean; brief?: boolean; chip?: boolean; resets?: boolean }

// Richest first; the first that fits the band's width wins. The sparkline outlasts the
// last-turn text as the band narrows. "full in" is the first thing to give way, ahead of the
// last turn's figures; then those shrink to the cost alone, then go, then the sparkline halves,
// then the copy mark goes, then the plans' reset timers, then the sparkline, so the context and the
// plans' percentages keep one row. Only a band too narrow even for those takes two rows. So
// "full in" shows only while the last turn's figures do too.
// (A band with no turns yet draws no bars, so these also serve for it.)
const LAYOUTS: Layout[] = [
  { session: true, spark: SPARK_SHOWN, fullIn: true },
  { session: true, spark: SPARK_SHOWN, fullIn: false },
  { session: true, spark: SPARK_SHOWN, fullIn: false, brief: true },
  { session: false, spark: SPARK_SHOWN, fullIn: false },
  { session: false, spark: NARROW_SPARK, fullIn: false },
  { session: false, spark: NARROW_SPARK, fullIn: false, chip: false },
  { session: false, spark: NARROW_SPARK, fullIn: false, chip: false, resets: false },
  { session: false, spark: 0, fullIn: false, chip: false, resets: false },
]

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

const span = (minutes: number) => {
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`

  return `${minutes}m`
}

const seconds = (ms: number) => {
  const s = Math.round(ms / 1000)

  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// Quiet until it matters: neutral when comfortable, yellow when the window is
// filling faster than the clock (or past 70%), red past 90% or when on pace to
// run out before it resets.
const tone = (percent: number, elapsed: number | null, isTight: boolean) => {
  if (percent >= 90 || isTight) return 'red'
  if (percent >= 70 || (elapsed !== null && percent - elapsed > 15)) return 'yellow'

  return undefined
}

type Plan = { label: string; percent: number; left: number | null; elapsedMin: number | null; total: number | null }

const plans = (limits: Limit[], now: number): Plan[] =>
  limits.map(l => {
    const left = l.resetsAt === undefined ? null : Math.max(0, Math.round((Date.parse(l.resetsAt) - now) / 60000))
    const total = WINDOW_MIN[l.kind] ?? null
    const elapsedMin = left !== null && total !== null ? total - left : null

    return { label: LABELS[l.kind] ?? l.kind, percent: l.percentUsed, left, elapsedMin, total }
  })

const conversation = (u: Usage): Part[] => {
  if (u.contextPercent === null) return []
  // Tinted like the plan windows, but against the limit that matters here: how far the context
  // has gone toward the point where it is compacted (the window's own percent when unknown).
  const toCompact = u.compactIn !== null && u.contextTokens != null ? u.contextTokens + Math.max(0, u.compactIn) : null
  const color = tone(
    toCompact !== null && u.contextTokens != null && toCompact > 0 ? (100 * u.contextTokens) / toCompact : u.contextPercent,
    null,
    false,
  )
  const figure = u.contextTokens != null ? tokens(u.contextTokens) : `${Math.round(u.contextPercent)}%`
  const parts: Part[] = [
    ['ctx ', { dimColor: true }],
    [figure, { color }],
  ]
  return parts
}

const plan = (p: Plan, o: Layout): Part[] => {
  const elapsed = p.elapsedMin !== null && p.total ? (100 * p.elapsedMin) / p.total : null
  // On pace to fill before the window resets: minutes until 100% at the rate so far.
  const toFull =
    p.elapsedMin !== null && p.elapsedMin >= 10 && p.percent > 0
      ? Math.round(((100 - p.percent) * p.elapsedMin) / p.percent)
      : null
  const isTight = toFull !== null && p.left !== null && toFull < p.left
  const color = tone(p.percent, elapsed, isTight)
  // Only the pace worth acting on: using the window faster than time passes.
  const pace = elapsed !== null && p.percent - elapsed > 5 ? '▲' : ''
  const parts: Part[] = [
    [`${p.label} `, { dimColor: true }],
    [`${Math.round(p.percent)}%${pace}`, { color }],
  ]
  if (p.left !== null && o.resets !== false) parts.push([` ↻${span(p.left)}`, { dimColor: true }])
  if (isTight && toFull !== null && o.fullIn !== false) parts.push([` full in ${span(toFull)}`, { color: 'red' }])

  return parts
}

// The last turn: its new tokens, how long it ran and, when the ledger knows, what it cost.
const turnParts = (turn: LastTurn | null, usd: number | null, brief = false): Part[] =>
  turn === null
    ? []
    : brief
      ? [[`↳ ${usd === null ? tokens(turn.tokens) : dollars(usd)}`, { dimColor: true }]]
      : [[`↳ ${tokens(turn.tokens)} ${seconds(turn.ms)}${usd === null ? '' : ` ${dollars(usd)}`}`, { dimColor: true }]]

// One bar per turn, as tall as what the turn cost against the dearest turn shown.
const barOf = (value: number, peak: number) =>
  BARS[Math.min(BARS.length - 1, Math.max(0, Math.ceil((value / Math.max(peak, 1e-9)) * BARS.length) - 1))]

// What a token kind costs next to a fresh input token (the price ratios hold across Claude
// models): an output token five times, a cache write 1.25, a cache read a tenth. The weights
// rank a turn's kinds by what they cost, and stand in for dollars when the ledger is silent.
const KINDS = [
  { name: 'in', weight: 1, color: 'green', of: (t: TurnPoint) => t.input },
  { name: 'cache+', weight: 1.25, color: 'yellow', of: (t: TurnPoint) => t.cacheWrite },
  { name: 'out', weight: 5, color: 'blue', of: (t: TurnPoint) => t.output },
  { name: 'cache read', weight: 0.1, color: 'gray', of: (t: TurnPoint) => t.cacheRead },
] as const

const weighted = (t: TurnPoint) => KINDS.reduce((n, k) => n + k.weight * k.of(t), 0)

// A cell holds one colour, so a bar shows the new work that cost the turn most: input, cache
// writes or output. Output is the quiet blue: it wins most turns, so it should not shout. Cache
// reads are left out of the choice: on a long session they are the biggest line of nearly every turn, and every bar would turn the same grey. A turn with no
// new work at all shows grey. The hover row carries the whole split.
const dominant = (t: TurnPoint) => {
  const fresh = KINDS.slice(0, 3).reduce((best, k) => (k.weight * k.of(t) > best.weight * best.of(t) ? k : best), KINDS[0])

  return fresh.of(t) > 0 ? fresh : KINDS[3]
}

// How wide the hover's stacked strip is, in cells.
const STACK_CELLS = 30

// A strip of blocks: a run per token kind, as long as that kind's share of the cost, each in the
// kind's colour. A kind that cost anything keeps a cell; the biggest run takes the rounding.
const stackOf = (weights: number[]): Part[] => {
  const total = weights.reduce((n, w) => n + w, 0)
  const shares = weights.map(w => (total === 0 ? 0 : w / total))
  const cells = shares.map(share => (share === 0 ? 0 : Math.max(1, Math.round(share * STACK_CELLS))))
  const biggest = shares.indexOf(Math.max(...shares))
  if (total > 0) cells[biggest] = Math.max(1, cells[biggest] + STACK_CELLS - cells.reduce((n, c) => n + c, 0))

  return [
    ['  ', {}],
    ...KINDS.flatMap((k, i): Part[] => (cells[i] === 0 ? [] : [['█'.repeat(cells[i]), { color: k.color }]])),
    ['  cost by kind', { dimColor: true }],
  ]
}

// One turn's cost as a strip, by the price weights.
const stackRow = (t: TurnPoint): Part[] => stackOf(KINDS.map(k => k.weight * k.of(t)))

// The share of a prompt's input tokens that came from the cache: reads over everything the model
// read (fresh input, cache writes and cache reads). Null when nothing was read.
const hitRate = (list: TurnPoint[]) => {
  const read = list.reduce((n, t) => n + t.cacheRead, 0)
  const all = read + list.reduce((n, t) => n + t.input + t.cacheWrite, 0)

  return all === 0 ? null : `${Math.round((read / all) * 100)}%`
}

const dollars = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

const modelName = (model: string) => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

// When a turn ended, in the viewer's local time: the clock alone for today, the date before it.
const stamp = (at: number, now: number) => {
  const d = new Date(at)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  return d.toDateString() === new Date(now).toDateString()
    ? clock
    : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}`
}

// Short names keep the detail rows to one line: C for cache writes, CR for cache reads.
const SHORT: Record<string, string> = { in: 'in', 'cache+': 'C', out: 'out', 'cache read': 'CR' }

// A turn's detail row: when it ended, what it spent by kind, how long, what it cost.
const turnRow = (t: TurnPoint, now: number): Part[] => [
  [`#${t.n} `, { dimColor: true }],
  ...(t.at === undefined ? [] : [[`${stamp(t.at, now)}  `, { dimColor: true }] as Part]),
  [`${tokens(t.tokens)} new`, {}],
  ...KINDS.flatMap((k, i): Part[] => [
    [`${i === 0 ? '  ' : ' · '}${SHORT[k.name]} `, { dimColor: true }],
    [tokens(k.of(t)), { color: k.color }],
  ]),
  ...(hitRate([t]) === null ? [] : [[`  hit ${hitRate([t])}`, { dimColor: true }] as Part]),
  [`  ${seconds(t.ms)}`, { dimColor: true }],
  ...(t.usd === null ? [] : [[`  ${dollars(t.usd)}`, {}] as Part]),
  [`  ${modelName(t.model)}`, { dimColor: true }],
]

// What each kind cost over the session: every turn's dollars split by the price weights, summed.
// The ledger holds one figure per turn, so this is an allocation; the kinds add up to the session
// total. Null unless every turn has dollars.
const kindDollars = (list: TurnPoint[]) =>
  list.some(t => t.usd === null)
    ? null
    : KINDS.map(k =>
        list.reduce((n, t) => {
          const total = weighted(t)

          return total === 0 ? n : n + ((t.usd as number) * k.weight * k.of(t)) / total
        }, 0),
      )

const spent = (ms: number) => (ms < 60000 ? seconds(ms) : span(Math.round(ms / 60000)))

// The whole recorded session in one row: turns, then each kind's tokens and dollars, the cache hit
// rate, the time it ran and the total dollars. Richest first; the first that fits `room` is drawn,
// so the row gives up time, then the hit rate, then the kinds' dollars, then the word "turns".
const totalRow = (list: TurnPoint[], room = Infinity): Part[] => {
  const usd = list.reduce((n, t) => n + (t.usd ?? 0), 0)
  const split = kindDollars(list)
  const hit = hitRate(list)
  const ms = list.reduce((n, t) => n + t.ms, 0)
  const build = (o: { each: boolean; hit: boolean; time: boolean; word: boolean }): Part[] => [
    [o.word ? `Σ ${list.length} turn${list.length === 1 ? '' : 's'}  ` : `Σ ${list.length}  `, { dimColor: true }],
    ...KINDS.flatMap((k, i): Part[] => [
      [`${i === 0 ? '' : ' · '}${SHORT[k.name]} `, { dimColor: true }],
      [tokens(list.reduce((n, t) => n + k.of(t), 0)), { color: k.color }],
      ...(o.each && split !== null ? [[` ${dollars(split[i])}`, { color: k.color }] as Part] : []),
    ]),
    ...(o.hit && hit !== null ? [[`  hit ${hit}`, { dimColor: true }] as Part] : []),
    ...(o.time ? [[`  ${spent(ms)}`, { dimColor: true }] as Part] : []),
    ...(list.some(t => t.usd !== null) ? [[`  ${dollars(usd)}`, {}] as Part] : []),
  ]
  const tiers = [
    { each: true, hit: true, time: true, word: true },
    { each: true, hit: true, time: false, word: true },
    { each: true, hit: false, time: false, word: true },
    { each: false, hit: false, time: false, word: true },
    { each: false, hit: false, time: false, word: false },
  ]

  return build(tiers.find(o => width(build(o)) <= room) ?? tiers[tiers.length - 1])
}

// The whole session as a strip: the per-kind dollars when every turn has them (the same figures the
// session row prints), else the price weights over the session's tokens.
const sessionStack = (list: TurnPoint[]): Part[] =>
  stackOf(kindDollars(list) ?? KINDS.map(k => k.weight * list.reduce((n, t) => n + k.of(t), 0)))

// The first skill by name, the rest as a count; hovering lists them all.
const skillLabel = (skills: SkillUse[]) =>
  skills.length === 0 ? '' : `/${skills[0].name}${skills.length > 1 ? ` +${skills.length - 1}` : ''}`

// One detail row per skill: name, where it really lives, and the folder it was read from.
const skillRow = (s: SkillUse, nameWidth: number): Part[] => [
  [`/${s.name}`.padEnd(nameWidth + 2), {}],
  [s.path ?? 'source unknown', { dimColor: true }],
  ...(s.via !== null && s.path !== null && !s.path.startsWith(s.via) ? [[`  via ${s.via}`, { dimColor: true }] as Part] : []),
]

const join = (groups: Part[][], gap: string): Part[] =>
  groups
    .filter(g => g.length > 0)
    .flatMap((g, i): Part[] => (i === 0 ? g : [[gap, { dimColor: true }], ...g]))

const width = (parts: Part[]) => parts.reduce((n, [text]) => n + text.length, 0)

const row = (parts: Part[], Text: any, key: string) => (
  <Text key={key} wrap="truncate-end">
    {parts.map(([text, style], i) => (
      <Text key={i} {...style}>
        {text}
      </Text>
    ))}
  </Text>
)

// The session id is not spelled out: the band keeps only a copy mark, and a press copies the id.
const ICON = '⧉'
// Spare cells at the band's edge (its padding, text a little wider than counted), so nothing is clipped.
const EDGE_MARGIN = 3

// The window that matters is the one compaction measures against (`rawMaxTokens`,
// often smaller than the model's), so the figures come from the breakdown when
// there is one; the plain context reading is the fallback.
const shape = (
  context: { percent?: number; tokens?: number; window?: number; breakdown?: any },
  rateLimits: Limit[],
): Usage => {
  const b = context.breakdown
  const window = b?.rawMaxTokens ?? context.window ?? null
  const used = b?.totalTokens ?? context.tokens ?? null

  return {
    contextPercent: b?.percentage ?? context.percent ?? null,
    contextTokens: used,
    contextWindow: window,
    compactIn: b?.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && used !== null ? b.autoCompactThreshold - used : null,
    limits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
  }
}

// The plan windows arrive with the first API response, so a fresh process has none to
// show. The last readings are kept across sessions and stand in until a live one lands;
// a window whose reset time has passed is dropped, its figure no longer true.
const STORE_LIMITS = 'limits'
const STORE_TURNS = 'turns'
const KEEP_SESSIONS = 15

const remembered = async ($: any, now: number): Promise<Limit[]> => {
  const saved = (await $.store.get(STORE_LIMITS).catch(() => undefined)) as Limit[] | undefined

  return Array.isArray(saved) ? saved.filter(l => l.resetsAt === undefined || Date.parse(l.resetsAt) > now) : []
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.session.usage({ breakdown: 'summary' })
    const limits = now.rateLimits.length > 0 ? now.rateLimits : await remembered($, await $.clock.now())
    await update($, usage, () => shape(now.context, limits))
    await update($, costMark, () => now.cost?.usd ?? null)

    // A resumed session gets its sparkline back, kept per session id.
    if ((await read($, turns)).length === 0) {
      const byId = ((await $.store.get(STORE_TURNS).catch(() => undefined)) ?? {}) as Record<string, TurnPoint[]>
      const mine = byId[await $.session.id()]

      if (Array.isArray(mine)) {
        await update($, turns, () => mine)
      }
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const limits = e.rateLimits.length > 0 ? e.rateLimits : await remembered($, await $.clock.now())
    await update($, usage, () => shape(context, limits))

    if (e.rateLimits.length > 0) {
      await $.store.set(STORE_LIMITS, e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage

    if (u && e.agentId === undefined) {
      const spent = u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
      await update($, lastTurn, () => ({ tokens: spent, ms: e.durationMs }))

      // This turn's dollars: what the session's ledger gained since the last main-loop turn
      // (a subagent's spend in between counts here, the turn that caused it).
      const total = (await $.session.usage()).cost?.usd ?? null
      const mark = await read($, costMark)
      const before = await read($, turns)
      const point: TurnPoint = {
        n: (before[before.length - 1]?.n ?? 0) + 1,
        tokens: spent,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        cacheRead: u.cache_read_input_tokens,
        ms: e.durationMs,
        at: await $.clock.now(),
        model: u.model,
        usd: total !== null && mark !== null ? Math.max(0, total - mark) : null,
      }
      await update($, turns, list => [...list, point])

      const byId = ((await $.store.get(STORE_TURNS).catch(() => undefined)) ?? {}) as Record<string, TurnPoint[]>
      const id = await $.session.id()
      delete byId[id]
      const kept = Object.entries({ ...byId, [id]: await read($, turns) }).slice(-KEEP_SESSIONS)
      await $.store.set(STORE_TURNS, Object.fromEntries(kept))
      await update($, costMark, () => total)
    }

    // The main loop's turn closes the list: what gathered since the last one is this turn's.
    if (e.agentId === undefined) {
      const gathered = await read($, pendingSkills)
      await update($, turnSkills, () => gathered)
      await update($, pendingSkills, () => [])
    }

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const loaded = BASE_DIR.exec(result.text ?? e.text)?.[1]?.trim() ?? null
    const real = loaded === null ? null : ((await $.fs.stat(loaded, { resolve: true }).catch(() => null))?.realPath ?? loaded)
    const bundled = loaded === null ? null : BUNDLED.exec(loaded)?.[1]
    const use: SkillUse = bundled
      ? { name: e.skill, path: `built-in (${bundled})`, via: null }
      : { name: e.skill, path: real && home(real), via: loaded && home(parent(loaded)) }
    await update($, pendingSkills, list => (list.some(s => s.name === use.name) ? list : [...list, use]))

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, usage)

    if (e.props.hasSurvey || current === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const turn = await read($, lastTurn)
    const everyTurn = await read($, turns)
    const history = everyTurn.slice(-SPARK_SHOWN)
    const skills = await read($, turnSkills)
    const sessionId = await $.session.id()
    const windows = plans(current.limits, now)
    const usageParts = (o: Layout): Part[] => {
      const gap = ' · '

      return join([conversation(current), join(windows.map(w => plan(w, o)), gap)], gap)
    }

    if (usageParts(LAYOUTS[0]).length === 0) {
      return next(e)
    }

    const chip = (
      <Button
        key="session-id"
        label={ICON}
        plain
        dimColor
        onPress={async press => {
          const copied = await $.ui.copy({ text: sessionId, surface: press.surface })
          $.ui.toast(copied.isCopied ? `Copied session id ${sessionId}` : `Could not copy session id (${copied.reason})`)
        }}
      />
    )
    // The skill label lights a group; the detail rows below it join the group
    // drawn hidden, so hovering the label (or the rows) unfolds them in the band.
    const shown = skills.slice(0, Math.max(1, e.props.maxRows - 2))
    const nameWidth = Math.max(...shown.map(s => s.name.length + 1))
    const skillTag =
      skills.length > 0 ? (
        <Box key="skills" marginLeft={2} hover={{ scope: SKILL_SCOPE }}>
          <Text dimColor hover={{ scope: SKILL_SCOPE, color: 'cyan' }}>
            {skillLabel(skills)}
          </Text>
        </Box>
      ) : null
    const details =
      skills.length > 0 ? (
        <Box key="skill-details" flexDirection="column" display="none" hover={{ scope: SKILL_SCOPE, display: 'flex' }}>
          {shown.map((s, i) => row(skillRow(s, nameWidth), Text, `skill-${i}`))}
          {skills.length > shown.length && row([[`+${skills.length - shown.length} more`, { dimColor: true }]], Text, 'skill-more')}
        </Box>
      ) : null

    // One bar per recent turn: its height is what the turn cost, its colour the kind of token
    // of new work that cost most (in green, cache writes yellow, out blue; grey if none). A bar
    // lights on hover and unfolds its turn's figures beneath the band.
    const recent = (o: Layout) => (o.spark === 0 ? [] : history.slice(-o.spark))
    const sparkWidth = (o: Layout) => (recent(o).length === 0 ? 0 : Math.ceil(recent(o).length * bar) + 1)
    // One bar, and one wide glyph, in the characters the width estimate counts.
    const bar = BAR_CHARS[e.surface] ?? 1
    const wide = (WIDE_GLYPH_CELLS[e.surface] ?? 1) / (GLYPH_WIDTH[e.surface] ?? 1)
    const sparkOf = (list: TurnPoint[]) => {
      // Dollars when every bar has them, else the same turns priced by weight, so the bars
      // never mix two scales.
      const priced = list.every(t => t.usd !== null)
      const cost = (t: TurnPoint) => (priced ? (t.usd as number) : weighted(t))
      const peak = Math.max(1e-9, ...list.map(cost))

      return (
        <Box key="spark" flexDirection="row" marginRight={1}>
          {list.map((t, i) => (
            <Text
              key={`bar-${t.n}`}
              dimColor={i !== list.length - 1}
              color={dominant(t).color}
              hover={{ scope: `usage-bar-turn-${t.n}`, color: 'cyan' }}
            >
              {barOf(cost(t), peak)}
            </Text>
          ))}
        </Box>
      )
    }
    // Hovering a bar unfolds its turn and the session total above the band: the band
    // clips anything placed over it, so the card grows the band instead of floating.
    const turnDetails = (list: TurnPoint[], room: number) => list.map(t => (
      <Box
        key={`turn-detail-${t.n}`}
        flexDirection="column"
        display="none"
        hover={{ scope: `usage-bar-turn-${t.n}`, display: 'flex' }}
      >
        {row(turnRow(t, now), Text, `turn-${t.n}`)}
        {row(stackRow(t), Text, `stack-${t.n}`)}
        {row(totalRow(everyTurn, room), Text, `total-${t.n}`)}
        {row(sessionStack(everyTurn), Text, `session-stack-${t.n}`)}
      </Box>
    ))

    // Usage on the left; this session's own figures and the id chip at the right edge.
    const line = (left: Part[], right: Part[], withSkills: boolean, spark: TurnPoint[] = [], withChip = true) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>{row(left, Text, 'usage')}</Box>
        <Box flexShrink={0} marginLeft={2} flexDirection="row">
          {spark.length > 0 && sparkOf(spark)}
          {right.length > 0 && row(right, Text, 'session')}
          {withSkills && skillTag}
          {withChip && <Box marginLeft={right.length > 0 || (withSkills && skillTag !== null) || spark.length > 0 ? 2 : 0}>{chip}</Box>}
        </Box>
      </Box>
    )

    const lastUsd = everyTurn[everyTurn.length - 1]?.usd ?? null
    const mine = turnParts(turn, lastUsd)
    const tag = skillLabel(skills)
    // The band's cells, in characters: more of them where a character is narrower than a cell.
    const glyph = GLYPH_WIDTH[e.surface] ?? 1
    const cells = Math.floor(e.props.bodyColumns / glyph)
    const iconCells = Math.ceil(ICON.length * wide)
    const columnsFor = (o: Layout) => cells - (o.chip === false ? 0 : iconCells) - EDGE_MARGIN
    const mineOf = (o: Layout) => (o.brief ? turnParts(turn, lastUsd, true) : mine)
    const mineWidth = (o: Layout) => width(mineOf(o)) + (tag ? tag.length + 2 : 0)
    // The width estimate runs a few cells optimistic (the band's padding, proportional text), and a
    // row that overflows by a little wraps its last words onto a second line. "full in" is the part
    // that sits at the end, so a row showing it asks for a margin: it fits whole or it is dropped.
    const need = (o: Layout) => {
      const parts = usageParts(o)
      const margin = parts.some(([text]) => text.includes('full in')) ? FULL_IN_MARGIN : 0

      return width(parts) + margin + (o.session && mineWidth(o) ? mineWidth(o) + 2 : 0) + sparkWidth(o)
    }
    const fit = LAYOUTS.find(o => need(o) <= columnsFor(o))

    if (fit !== undefined) {
      return (
        <Box flexDirection="column">
          {turnDetails(recent(fit), cells - EDGE_MARGIN)}
          {line(usageParts(fit), fit.session ? mineOf(fit) : [], fit.session, recent(fit), fit.chip !== false)}
          {fit.session && details}
        </Box>
      )
    }

    // Too narrow for one row: context above, plan windows below, in the same compact style. The
    // sparkline stays, at the right of the last row beside the copy mark, so it is never lost to
    // width. That last row drops "full in" if it must, so nothing is ever clipped or wrapped.
    const last: Layout = { session: false, spark: NARROW_SPARK, fullIn: true }
    const small = history.slice(-NARROW_SPARK)
    const rowsAt = (o: Layout) =>
      [conversation(current), join(windows.map(w => plan(w, o)), ' · ')].filter(r => r.length > 0)
    const rows = rowsAt(last)
    const beside = (small.length > 0 ? Math.ceil(small.length * bar) + 1 : 0) + 4 // sparkline, and the gaps before the chip
    const roomFor = (r: Part[]) =>
      width(r) + (r.some(([text]) => text.includes('full in')) ? FULL_IN_MARGIN : 0) + beside + Math.ceil(ICON.length * wide) <= cells - EDGE_MARGIN

    if (!roomFor(rows[rows.length - 1])) {
      rows[rows.length - 1] = rowsAt({ ...last, fullIn: false })[rows.length - 1]
    }

    return (
      <Box flexDirection="column">
        {turnDetails(small, cells - EDGE_MARGIN)}
        {rows.slice(0, -1).map((r, i) => row(r, Text, `r${i}`))}
        {/* No wrapper box: it would shrink to its content and leave nothing to push the sparkline and id to the edge. */}
        {line(rows[rows.length - 1], [], false, small)}
      </Box>
    )
  })
}
