import { expect, test } from 'claude-code/testing'

const SESSION = 'bf8e756a-9f0a-4c40-b606-cda8d6ab19c7'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { bodyRows: 10, offset: 0, total: 1 },
  view: {},
} as any

// The drawn element keyed `key`, with its `hover` and group stamp as drawn.
const drawnKey = (node: any, key: string): any =>
  typeof node !== 'object' || node === null
    ? undefined
    : node.props?.key === key
      ? node
      : (node.children ?? []).map((c: any) => drawnKey(c, key)).find(Boolean)

// The drawn tree's text, runs joined as the surface shows them.
const flat = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(flat).join('')

// An in-memory `$.store`, shared by the test's hooks.
const memoryStore = (on: any, seed: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...seed }
  on('store.get', async (_$: any, e: any) => ({ value: data[e.key] }))
  on('store.set', async (_$: any, e: any) => { data[e.key] = e.value; return { value: undefined } as any })

  return data
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band shows only a copy mark and a press copies the session id`, async ($, on) => {
    const copies: string[] = []
    const toasts: string[] = []
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-10T12:00:00Z') }))
    on('ui.copy', async (_$, e) => {
      copies.push(e.text)

      return { value: { isCopied: true } }
    })
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 34, tokens: 68000, window: 200000 },
        rateLimits: [],
        cost: { usd: 0.26 },
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    const chip = await ui.find({ key: 'session-id' })

    expect(chip?.text).toBe('⧉')

    await ui.press({ key: 'session-id' })

    expect(copies).toEqual([SESSION])
    expect(toasts).toEqual([`Copied session id ${SESSION}`])
  })

  test(`${surface}: the last turn, its cost and its skill`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-10T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 65, tokens: 130000, window: 200000 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 29, resetsAt: '2026-10-10T14:22:00Z' }],
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    on('skill.prompt', async (_$, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    await $.skill.prompt({ skill: 'plugin-authoring', text: 'Do the thing.' })
    await $.turn.complete({
      answer: '',
      durationMs: 48000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: { input_tokens: 2000, output_tokens: 1000, cache_creation_input_tokens: 9000, cache_read_input_tokens: 100000, model: 'claude-opus-5-5' },
    } as any)

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    const text = flat(await ui.drawn())

    expect(text).not.toContain('●')
    expect(text).toContain('↻2h22m')
    expect(text).toContain('↳ 12k 48s')
    expect(text).toContain('/plugin-authoring')
    expect(text).not.toContain(' +')
  })

  test(`${surface}: a sparkline of turn sizes, each bar unfolding its turn's figures and dollars on hover`, async ($, on) => {
    let spent = 1
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-10T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 20, tokens: 40000, window: 200000 },
        rateLimits: [],
        cost: { usd: spent },
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    const done = async (id: string, output: number, cost: number, agentId?: string, written = 0) => {
      spent += cost
      await $.turn.complete({
        answer: '',
        durationMs: 2000,
        isAborted: false,
        turnId: id,
        reason: 'answer',
        agentId,
        usage: { input_tokens: 100, output_tokens: output, cache_creation_input_tokens: written, cache_read_input_tokens: 50000, model: 'claude-opus-5-5' },
      } as any)
    }
    await done('t1', 1000, 0.1)
    await done('t2', 30000, 0.5)
    await done('sub', 999, 9, 'agent-1') // a subagent's turn is not a bar
    await done('t3', 100, 0.02, undefined, 5000)

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    const drawn = await ui.drawn()
    const spark = await ui.find({ key: 'spark' })

    // Height is each turn's cost ($0.10, $0.50, and the subagent's $9 landing on the third).
    expect(spark?.text).toBe('▁▁█')
    // Colour is the new work that cost the turn most: output (blue) for the 1k and 30k turns,
    // cache writes (yellow) for the last. Cache reads never decide: they top every long turn.
    expect(drawnKey(drawn, 'spark')?.children.map((c: any) => c.props?.color)).toEqual(['blue', 'blue', 'yellow'])
    // The last turn leads with its tokens and time, then what it cost.
    expect(flat(drawn)).toContain('↳ 5k 2s $9.02')

    expect(drawnKey(drawn, 'spark')?.children[1].hover).toEqual({ scope: 'usage-bar-turn-2', color: 'cyan' })
    expect(drawnKey(drawn, 'turn-detail-2')?.hover).toEqual({ scope: 'usage-bar-turn-2', display: 'flex' })
    expect((await ui.find({ key: 'turn-detail-2' }))?.props?.display).toBe('none')

    const second = (await ui.find({ key: 'turn-detail-2' }))?.text
    // The turn's end time leads the row: the clock alone, as the mocked "now" is the same day.
    expect(second).toMatch(/#2 \d\d:\d\d {2}30k new/)
    expect(second).toContain('in 100 · C 0 · out 30k')
    expect(second).toContain('CR 50k')
    // The subagent's $9 lands in the next main turn's dollars, the turn that caused it.
    expect((await ui.find({ key: 'turn-detail-3' }))?.text).toContain('$9.02')
    expect(second).toContain('$0.50')
    expect(second).toContain('opus-5-5')
    // Cache hit: reads over all the input read, here 50k of 50.1k.
    expect(second).toContain('hit 100%')
    expect(second).toMatch(/Σ 3 turns[^#]*hit 9\d%/)
    // The strip splits the turn's cost by kind and is always 30 cells: turn 2's 30k output at x5
    // is nearly all of it, with a cell each left for the tiny input and the cache read.
    // The detail holds two strips (the turn's, then the session's), 30 cells each.
    expect((second?.match(/█/g) ?? []).length).toBe(60)
    expect(second).toContain('cost by kind')
    // The session row is one line: each kind's tokens and dollars (C is cache writes, CR cache reads),
    // the hit rate, the time and the total. The dollars split every turn's cost by the price weights,
    // so the kinds add up to the total (the subagent's $9 lands on turn 3's cache writes).
    const after = second?.slice(second.indexOf('cost by kind') + 'cost by kind'.length) ?? ''
    const session = after.split('\n').find(r => r.includes('Σ')) ?? ''
    // Under it, the session's own strip: 30 cells again, split by the same per-kind dollars as the row
    // ($0.08 input is under a cell's worth, so it keeps one; cache writes and reads take most).
    const strip = after.split('\n').filter(r => r.includes('█')).pop() ?? ''
    expect((strip.match(/█/g) ?? []).length).toBe(30)
    expect(after.trimEnd().endsWith('cost by kind')).toBe(true)
    expect(session).toContain('Σ 3 turns  in 300 $0.08 · C 5k $4.76 · out 31k $0.91 · CR 150k $3.87  hit 97%  6s  $9.62')
    const dollarsOf = [...session.matchAll(/\$(\d+\.\d\d)/g)].map(m => Number(m[1]))
    expect(Math.abs(dollarsOf.slice(0, 4).reduce((a, b) => a + b, 0) - (dollarsOf[4] ?? 0))).toBeLessThan(0.02)

    // Narrowing the band gives up time, then the hit rate, then each kind's dollars, then "turns",
    // and the row never gets longer, so it stays one line.
    const rows: string[] = []
    for (let columns = 200; columns >= 40; columns -= 4) {
      const m = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: columns } })
      const text = (await m.find({ key: 'turn-detail-2' }))?.text ?? ''
      rows.push((text.slice(text.indexOf('cost by kind') + 'cost by kind'.length).split('\n').find(r => r.includes('Σ')) ?? ''))
    }
    expect(rows[0]).toBe(session)
    expect(rows.every(r => !r.includes('\n'))).toBe(true)
    expect(rows.map(r => r.length)).toEqual([...rows.map(r => r.length)].sort((a, b) => b - a))
    expect(rows.some(r => r.includes('hit') && !r.includes('6s'))).toBe(true)
    expect(rows.some(r => !r.includes('hit') && r.includes('$0.08'))).toBe(true)
    expect(rows.some(r => !r.includes('$0.08') && r.includes('turns'))).toBe(true)
    expect(rows.some(r => /Σ 3 {2}in/.test(r))).toBe(true)
  })

  test(`${surface}: a narrow band drops the last-turn text before the sparkline`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-10T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 78, tokens: 156000, window: 200000 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 55, resetsAt: '2026-10-10T15:03:00Z' }],
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    for (const id of ['a', 'b', 'c']) {
      await $.turn.complete({
        answer: '', durationMs: 1000, isAborted: false, turnId: id, reason: 'answer',
        usage: { input_tokens: 10, output_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-5-5' },
      } as any)
    }

    const wide = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    expect(flat(await wide.drawn())).toContain('↳')

    const narrow = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: surface === 'desktop' ? 36 : 38 } })
    const text = flat(await narrow.drawn())
    expect(text).not.toContain('●')
    expect(text).not.toContain('↳')
    expect((await narrow.find({ key: 'spark' }))?.text).toBe('███')
  })

  test(`${surface}: the sparkline survives the two-row layout when the plan alerts make the band long`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-31T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 50, tokens: 100000, window: 200000 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 9, resetsAt: '2026-10-31T15:08:00Z' },
          { kind: 'seven_day', percentUsed: 11, resetsAt: '2026-11-07T06:18:00Z' },
        ],
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    for (const [id, output] of [['a', 100], ['b', 5000], ['c', 100]] as const) {
      await $.turn.complete({
        answer: '', durationMs: 1000, isAborted: false, turnId: id, reason: 'answer',
        usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-5-5' },
      } as any)
    }

    // Too narrow for one row at any layout, compact included: two rows, and the bars still drawn.
    const narrow = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 20 } })
    const drawn = await narrow.drawn()
    // The same compact style as the one row: tokens, no dots, whatever the row's room.
    expect(flat(drawn)).toContain('ctx 100k')
    expect(flat(drawn)).not.toContain('●')
    expect(flat(drawn)).toContain('5h 9%')
    expect((await narrow.find({ key: 'spark' }))?.text).toBe('▁█▁')
    expect(drawnKey(drawn, 'turn-detail-2')?.hover).toEqual({ scope: 'usage-bar-turn-2', display: 'flex' })
    // The row holding the bars and the id is a direct child of the band, not inside a
    // shrink-to-fit wrapper, so space-between can push them to the right edge.
    expect((drawn.children ?? []).some((c: any) => c.props?.justifyContent === 'space-between')).toBe(true)

    // Wide enough for one row, bars and copy mark: always a sparkline.
    for (const bodyColumns of [20, 60, 70, 80, 90, 120]) {
      const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
      expect((await ui.find({ key: 'spark' }))?.text, `at ${bodyColumns} columns`).toBe('▁█▁')
    }
  })

  test(`${surface}: the desktop counts its narrower glyphs, so a band that has room stays on one row`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-31T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 69, tokens: 138000, window: 200000, breakdown: { percentage: 69, rawMaxTokens: 200000, totalTokens: 138000, isAutoCompactEnabled: true, autoCompactThreshold: 166000 } },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 15, resetsAt: '2026-10-31T15:03:00Z' },
          { kind: 'seven_day', percentUsed: 11, resetsAt: '2026-11-07T06:18:00Z' },
        ],
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    for (const output of [2000, 9000, 9500, 30]) {
      await $.turn.complete({
        answer: '', durationMs: 1000, isAborted: false, turnId: `t${output}`, reason: 'answer',
        usage: { input_tokens: 2, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-5-5' },
      } as any)
    }

    const at = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })

      return { oneRow: /\s·\s+5h/.test(flat(await ui.drawn())), spark: (await ui.find({ key: 'spark' }))?.text, chip: (await ui.find({ key: 'session-id' })) !== undefined, resets: flat(await ui.drawn()).includes('↻') }
    }

    // The band sheds, in order, as it narrows: the copy mark, the plans' reset timers (`↻3h41m`), the bars; only then two rows.
    // 49 columns on the terminal, 46 on the desktop (its text is narrower): everything fits on one row.
    expect(await at(surface === 'desktop' ? 46 : 49)).toEqual({ oneRow: true, spark: '██▁', chip: true, resets: true })
    // One column short: the copy mark goes first.
    expect(await at(surface === 'desktop' ? 44 : 48)).toEqual({ oneRow: true, spark: '██▁', chip: false, resets: true })
    // Narrower: the timers go, the percentages and the three bars stay, still one row.
    expect(await at(40)).toEqual({ oneRow: true, spark: '██▁', chip: false, resets: false })
    // Narrower still: the bars go too, the row stays one row.
    expect(await at(30)).toEqual({ oneRow: true, spark: undefined, chip: false, resets: false })
    // Too narrow even for that: two rows, with everything kept.
    expect(await at(20)).toEqual({ oneRow: false, spark: '██▁', chip: true, resets: true })
  })

  test(`${surface}: at a typical width one compact row: ctx as tokens, " · " separators, "full in" dropped first`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-31T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: 33, tokens: 66000, window: 200000 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 19, resetsAt: '2026-10-31T12:54:00Z' },
          // 85% with 2d0h left: well ahead of the clock (▲) and on pace to run out ("full in").
          { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-11-02T12:00:00Z' },
        ],
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    for (const output of [1000, 9000, 2000]) {
      await $.turn.complete({
        answer: '', durationMs: 1000, isAborted: false, turnId: `t${output}`, reason: 'answer',
        usage: { input_tokens: 2, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-5-5' },
      } as any)
    }

    const shownAt = async (bodyColumns: number) => {
      const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
      const drawn = await ui.drawn()

      return { text: flat(drawn), drawn }
    }

    // Wide enough for the compact row with "full in" and the last turn's figures.
    const roomy = await shownAt(surface === 'desktop' ? 77 : 81)
    expect(roomy.text).toContain('ctx 66k · 5h 19% ↻54m · 7d 85%▲ ↻2d0h full in')
    expect(roomy.text).not.toContain('●')
    expect(roomy.text).not.toContain('ctx 33%')

    // A little tighter: "full in" goes first, the last turn's figures stay.
    const typical = await shownAt(surface === 'desktop' ? 58 : 61)
    expect(typical.text).toContain('ctx 66k · 5h 19% ↻54m · 7d 85%▲ ↻2d0h')
    expect(typical.text).not.toContain('full in')
    expect(typical.text).toContain('↳ 2k 1s')
    expect((typical.drawn.children ?? []).some((c: any) => c.props?.justifyContent === 'space-between')).toBe(true)
    expect(typical.text).toContain('▁█▂')

    // Tighter still: the last turn's figures go next, the plan metrics and bars stay.
    const tight = await shownAt(surface === 'desktop' ? 46 : 50)
    expect(tight.text).toContain('ctx 66k · 5h 19% ↻54m · 7d 85%▲ ↻2d0h')
    expect(tight.text).not.toContain('↳')
    expect(tight.text).toContain('▁█▂')

    // Between the full figures and none, the last turn shrinks to one figure instead of vanishing.
    const briefAt: number[] = []
    for (let bodyColumns = 30; bodyColumns <= 100; bodyColumns++) {
      const { text } = await shownAt(bodyColumns)
      if (text.endsWith('▁█▂↳ 2k')) briefAt.push(bodyColumns)
    }
    expect(briefAt.length, 'a width where only the one figure fits').toBeGreaterThan(0)

    // Never half there: at every width "full in" is whole on the one row, or gone.
    for (let bodyColumns = 30; bodyColumns <= 100; bodyColumns++) {
      const { text } = await shownAt(bodyColumns)
      const full = text.includes('full in')
      if (full) expect(text, `at ${bodyColumns} columns`).toMatch(/full in \d+[dhm]/)
      // "full in" never outlasts the last turn's figures.
      if (full) expect(text, `at ${bodyColumns} columns`).toContain('↳')
      // Shown with the margin: the usage text and bars fit with at least FULL_IN_MARGIN to spare.
      if (full) expect(bodyColumns, `at ${bodyColumns} columns`).toBeGreaterThanOrEqual(surface === 'desktop' ? 63 : 73)
    }
  })

  test(`${surface}: ctx is tinted by how far it is toward compaction, and no compaction warning is drawn`, async ($, on) => {
    let tokensNow = 100000
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-31T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: {
        startedAt: 0,
        context: { percent: tokensNow / 2000, tokens: tokensNow, window: 200000, breakdown: { percentage: tokensNow / 2000, rawMaxTokens: 200000, totalTokens: tokensNow, isAutoCompactEnabled: true, autoCompactThreshold: 166000 } },
        rateLimits: [],
      } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    // The drawn run whose only text is `text`.
    const runOf = (node: any, text: string): any =>
      typeof node !== 'object' || node === null
        ? undefined
        : (node.children ?? []).length === 1 && node.children[0] === text
          ? node
          : (node.children ?? []).map((c: any) => runOf(c, text)).find(Boolean)

    for (const [used, label, color] of [[100000, '100k', undefined], [135000, '135k', 'yellow'], [160000, '160k', 'red']] as const) {
      tokensNow = used
      await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
      const drawn = await (await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })).drawn()

      expect(flat(drawn), label).toContain(`${label}`)
      expect(flat(drawn)).not.toContain('⚠')
      expect(runOf(drawn, label)?.props?.color, label).toBe(color)
    }
  })

  test(`${surface}: five bars when the band has the width, three when it does not, the whole history kept behind them`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-31T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { percent: 20, tokens: 40000, window: 200000 }, rateLimits: [] } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    for (let i = 1; i <= 60; i++) {
      await $.turn.complete({
        answer: '', durationMs: 1000, isAborted: false, turnId: `t${i}`, reason: 'answer',
        usage: { input_tokens: 1, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-5-5' },
      } as any)
    }

    const wide = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    expect((await wide.find({ key: 'spark' }))?.text).toHaveLength(5)
    // No bar is for an old turn only: the hover on the newest shows the whole session's total.
    expect((await wide.find({ key: 'turn-detail-60' }))?.text).toContain('Σ 60 turns  in 60 · C 0 · out 60k')

    const narrow = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: surface === 'desktop' ? 17 : 15 } })
    expect((await narrow.find({ key: 'spark' }))?.text).toHaveLength(3)
  })

  test(`${surface}: a fresh process shows the remembered plan windows and this session's sparkline`, async ($, on) => {
    const point = (n: number, output: number) => ({
      n, tokens: output, input: 1, output, cacheWrite: 0, cacheRead: 0, ms: 1000, model: 'claude-opus-5-5', usd: null,
    })
    memoryStore(on, {
      limits: [
        { kind: 'five_hour', percentUsed: 60, resetsAt: '2026-10-10T15:03:00Z' },
        { kind: 'seven_day', percentUsed: 8, resetsAt: '2026-10-10T11:00:00Z' }, // already reset
      ],
      turns: { [SESSION]: [point(1, 1000), point(2, 9000)], other: [point(1, 5)] },
    })
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-10T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { percent: 40, tokens: 80000, window: 200000 }, rateLimits: [] } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    const text = flat(await ui.drawn())
    expect(text).toContain('5h')
    expect(text).not.toContain('7d')
    expect((await ui.find({ key: 'spark' }))?.text).toMatch(/^▁█/)
  })

  test(`${surface}: every skill of the last turn, unfolded on hover with where each lives`, async ($, on) => {
    memoryStore(on)
    on('session.id', async () => ({ value: SESSION }))
    on('clock.now', async () => ({ value: Date.parse('2026-10-10T12:00:00Z') }))
    on('ui.render', async () => null as any)
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { percent: 20, tokens: 40000, window: 200000 }, rateLimits: [] } as any,
    }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('turn.complete', async () => ({ text: '' }))
    on('skill.prompt', async (_$, e) => ({ text: e.text }))
    on('fs.stat', async (_$, e) => ({
      value: {
        kind: 'dir',
        size: 0,
        mtimeMs: 0,
        isLink: e.path.includes('/.claude/skills/'),
        realPath: e.path.replace('/Users/me/.claude/skills/', '/Users/me/Projects/superpowers/skills/'),
      } as any,
    }))
    const done = (turnId: string, agentId?: string) =>
      $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId, reason: 'answer', agentId } as any)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    // An earlier turn's skill is not this turn's.
    await $.skill.prompt({ skill: 'old-one', text: 'Base directory for this skill: /Users/me/.claude/skills/old-one\n' })
    await done('t0')
    await $.skill.prompt({ skill: 'tdd', text: 'Base directory for this skill: /Users/me/.claude/skills/tdd\n\nRed, green.' })
    await $.skill.prompt({ skill: 'plugin-authoring', text: 'Base directory for this skill: /Users/me/.claude/plugins/cache/x/plugin-authoring\n' })
    await $.skill.prompt({ skill: 'tdd', text: 'Base directory for this skill: /Users/me/.claude/skills/tdd\n' })
    await done('t1-sub', 'agent-1') // a subagent finishing does not close the main turn
    await $.skill.prompt({ skill: 'no-header', text: 'Just text.' })
    await $.skill.prompt({
      skill: 'mod-maker',
      text: 'Base directory for this skill: /private/tmp/claude-501/bundled-skills/2.1.295/327c33175991d1f5/mod-maker\n',
    })
    await done('t1')

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    const tag = await ui.find({ key: 'skills' })
    const details = await ui.find({ key: 'skill-details' })
    const text = flat(await ui.drawn())

    expect(tag?.text).toBe('/tdd +3')
    expect(details?.props?.display).toBe('none')
    const drawn = await ui.drawn()
    expect(drawnKey(drawn, 'skill-details')?.hover).toEqual({ scope: 'usage-bar-skills', display: 'flex' })
    expect(drawnKey(drawn, 'skills')?.hover).toEqual({ scope: 'usage-bar-skills' })
    expect(details?.text).toContain('~/Projects/superpowers/skills/tdd  via ~/.claude/skills')
    expect(details?.text).toContain('~/.claude/plugins/cache/x/plugin-authoring')
    expect(details?.text).not.toContain('plugin-authoring  via')
    expect(details?.text).toContain('/no-header')
    expect(details?.text).toContain('source unknown')
    expect(details?.text).toContain('built-in (2.1.295)')
    expect(details?.text).not.toContain('bundled-skills')
    expect(text).not.toContain('old-one')
  })
}
