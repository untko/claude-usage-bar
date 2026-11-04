export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  contextPercent: number | null
  contextWindow: number | null
  compactIn: number | null
  limits: Limit[]
}
export type LastTurn = { tokens: number; ms: number }
// One finished main-loop turn: new tokens (input, output, cache writes), the cache
// reads beside them, how long it ran, when it ended (epoch ms; absent on turns recorded
// before it was kept), and the session cost it added (null when unknown).
export type TurnPoint = {
  n: number
  tokens: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  ms: number
  at?: number
  model: string
  usd: number | null
}
// A skill expanded for the model: where the engine read it (`via`, its folder's
// parent) and where that folder really lives once links are followed (`path`).
export type SkillUse = { name: string; path: string | null; via: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      usage: Usage | null
      lastTurn: LastTurn | null
      turns: TurnPoint[]
      costMark: number | null
      turnSkills: SkillUse[]
      pendingSkills: SkillUse[]
      surface: string | null
    }
  }
}
