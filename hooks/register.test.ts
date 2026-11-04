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
  test(`${surface}: the band shows the short session id and a press copies all of it`, async ($, on) => {
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

    expect(chip?.text).toContain('bf8e756a')
    expect(chip?.text).not.toContain('9f0a')

    await ui.press({ key: 'session-id' })

    expect(copies).toEqual([SESSION])
    expect(toasts).toEqual([`Copied session id ${SESSION}`])
  })

  test(`${surface}: dots, the last turn and its skill`, async ($, on) => {
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

    expect(text).toContain('●●●○')
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

    const done = async (id: string, output: number, cost: number, agentId?: string) => {
      spent += cost
      await $.turn.complete({
        answer: '',
        durationMs: 2000,
        isAborted: false,
        turnId: id,
        reason: 'answer',
        agentId,
        usage: { input_tokens: 100, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000, model: 'claude-opus-5-5' },
      } as any)
    }
    await done('t1', 1000, 0.1)
    await done('t2', 30000, 0.5)
    await done('sub', 999, 9, 'agent-1') // a subagent's turn is not a bar
    await done('t3', 100, 0.02)

    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: PROPS })
    const drawn = await ui.drawn()
    const spark = await ui.find({ key: 'spark' })

    expect(spark?.text).toBe('▁█▁')

    expect(drawnKey(drawn, 'spark')?.children[1].hover).toEqual({ scope: 'usage-bar-turn-2', color: 'cyan' })
    expect(drawnKey(drawn, 'turn-detail-2')?.hover).toEqual({ scope: 'usage-bar-turn-2', display: 'flex' })
    expect((await ui.find({ key: 'turn-detail-2' }))?.props?.display).toBe('none')

    const second = (await ui.find({ key: 'turn-detail-2' }))?.text
    // The turn's end time leads the row: the clock alone, as the mocked "now" is the same day.
    expect(second).toMatch(/#2 \d\d:\d\d {2}30k new/)
    expect(second).toContain('in 100 · out 30k · cache+ 0')
    expect(second).toContain('cache read 50k')
    // The subagent's $9 lands in the next main turn's dollars, the turn that caused it.
    expect((await ui.find({ key: 'turn-detail-3' }))?.text).toContain('$9.02')
    expect(second).toContain('$0.50')
    expect(second).toContain('opus-5-5')
    expect(second).toContain('Σ 3 turns 31k new')
  })

  test(`${surface}: a narrow band drops dots and the last-turn text before the sparkline`, async ($, on) => {
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

    const narrow = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 56 } })
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

    // Too narrow for one row at any layout: two rows, and the bars still drawn.
    const narrow = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 50 } })
    const drawn = await narrow.drawn()
    expect(flat(drawn)).not.toContain('●')
    expect((await narrow.find({ key: 'spark' }))?.text).toBe('▁█▁')
    expect(drawnKey(drawn, 'turn-detail-2')?.hover).toEqual({ scope: 'usage-bar-turn-2', display: 'flex' })
    // The row holding the bars and the id is a direct child of the band, not inside a
    // shrink-to-fit wrapper, so space-between can push them to the right edge.
    expect((drawn.children ?? []).some((c: any) => c.props?.justifyContent === 'space-between')).toBe(true)

    // Several widths, one answer: there is always a sparkline.
    for (const bodyColumns of [30, 40, 50, 60, 70, 80, 90, 120]) {
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

    // 76 columns: the terminal's cells are exact and too few for one row; the desktop's text is narrower.
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 76 } })
    const oneRow = /\s·\s+5h/.test(flat(await ui.drawn()))
    expect(oneRow).toBe(surface === 'desktop')
    expect((await ui.find({ key: 'spark' }))?.text).toBe('▂██▁')
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
