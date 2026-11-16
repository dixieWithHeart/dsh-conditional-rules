/**
 * 每会话的运行时状态缓存。
 *
 * `text()` 每步都会被调用，必须只读内存：这里的所有值由事件写入，
 * 求值时不做任何 IO、不 await、不扫描历史。
 *
 * 字段来源：
 *   turn / usedTokens / remainingTokens / percent ← session/event（turn/start、assistant/message）
 *   step / userText / cwd / sessionId            ← agent/pre-step
 *   toolHits                                     ← tools/pre-execute、tools/post-execute
 *   injected                                     ← 命中后由调用方写入（once / cooldown 依据）
 */

import { MAX_USER_TEXT } from './constants.js'
import { toolKey } from './conditions.js'

const sessions = new Map()
const MAX_SESSIONS = 64

function blank (sessionId) {
  return {
    sessionId: sessionId || '',
    cwd: '',
    turn: 0,
    step: 0,
    userText: '',
    percent: null,
    usedTokens: null,
    remainingTokens: null,
    toolHits: new Set(),
    toolName: '',
    injected: new Map(),
    // 最近一次活动的时间（用于挑「当前会话」，不能靠 Map 插入顺序）
    lastSeen: 0,
    // 本回合是否已由 turn/start 事件给出权威回合号（避免与 pre-step 的兜底递增重复计数）
    turnSynced: false,
  }
}

/** 取（必要时创建）某会话的状态。超过上限时按插入顺序淘汰最旧的。 */
export function stateOf (sessionId) {
  const key = String(sessionId || '')
  let state = sessions.get(key)
  if (!state) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next()
      if (!oldest.done) sessions.delete(oldest.value)
    }
    state = blank(key)
    sessions.set(key, state)
  }
  return state
}

export function peekState (sessionId) {
  return sessions.get(String(sessionId || '')) || null
}

/** 全部会话状态（供设置页展示）。 */
export function allStates () {
  return [...sessions.values()]
}

/** 取会话 id：assembleContext 只保证 scope，兼容它直接是 id 的情况。 */
export function sessionIdOf (assembleContext) {
  const scope = assembleContext && (assembleContext.scope ?? assembleContext.agent)
  const id = scope && scope.id
  return typeof id === 'string' && id.length > 0 ? id : ''
}

/**
 * agent/pre-step：更新步号、用户文本、工作目录；新回合时清掉工具标记。
 *
 * 命中记录的提交不在这里：`assemble()` 在 `agent/pre-step` **之前**调用，
 * 如果把「上一步命中」的提交放在 pre-step，同一步内的第二次 assemble（准入刷新）
 * 就会看到 once 已生效而返回空串，框架据此认为上下文变空。
 * 所以命中由 `noteHit()` 在 text() 里直接写，靠「同回合幂等」保证多次调用一致。
 */
export function notePreStep (sessionId, { step, userText, cwd }) {
  const state = stateOf(sessionId)
  state.lastSeen = Date.now()
  if (typeof step === 'number' && step > 0) {
    if (step === 1) {
      // 新回合：上一回合的工具标记作废（工具条件只在命中后的下一步生效）
      state.toolHits.clear()
      state.toolName = ''
      // 回合号有两个来源：turn/start 事件（权威）与按 step===1 的兜底递增。
      // 两者都加会让 turn 每回合 +2，所以事件给过就以事件为准。
      if (state.turnSynced) state.turnSynced = false
      else state.turn = state.turn + 1
    }
    state.step = step
  }
  if (typeof userText === 'string') state.userText = userText.slice(0, MAX_USER_TEXT)
  if (typeof cwd === 'string' && cwd) state.cwd = cwd
  return state
}

/**
 * 登记一次命中。幂等：同一回合内重复调用只记一次，
 * 这样 text() 被多次调用时 injected 不变，once / cooldown 的判定结果恒定。
 */
export function noteHit (sessionId, rules) {
  const state = peekState(sessionId)
  if (!state || !Array.isArray(rules)) return
  const turn = state.turn || 0
  const now = Date.now()
  state.lastSeen = now
  for (const rule of rules) {
    const entry = state.injected.get(rule.id)
    if (entry && entry.lastTurn === turn) continue
    state.injected.set(rule.id, {
      count: (entry ? entry.count : 0) + 1,
      lastTurn: turn,
      lastAt: now,
    })
  }
}

/** session/event：turn/start 与 assistant/message（占用与 token）。 */
export function noteSessionEvent (sessionId, event) {
  if (!event || typeof event !== 'object') return null
  const state = stateOf(sessionId)

  if (event.type === 'turn/start') {
    const t = event.data && event.data.turn
    if (typeof t === 'number' && t > 0) {
      state.turn = t
      // 权威值已到：本回合的 pre-step 不要再兜底递增
      state.turnSynced = true
    }
    return state
  }

  if (event.type === 'assistant/message') {
    const usage = event.data && event.data.usage
    if (!usage || typeof usage !== 'object') return state
    const used = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
    if (used > 0) {
      state.usedTokens = used
      const window = state.contextWindow
      if (typeof window === 'number' && window > 0) {
        state.percent = Math.min(100, (used / window) * 100)
        state.remainingTokens = Math.max(0, window - used)
      }
    }
    return state
  }

  if (event.type === 'request/context') {
    const w = event.data && event.data.contextWindow
    if (typeof w === 'number' && w > 0) {
      state.contextWindow = w
      if (typeof state.usedTokens === 'number') {
        state.percent = Math.min(100, (state.usedTokens / w) * 100)
        state.remainingTokens = Math.max(0, w - state.usedTokens)
      }
    }
    return state
  }

  return state
}

/** 工具事件：记一次性标记，供下一步求值使用。 */
export function noteTool (sessionId, name, phase) {
  if (!name) return null
  const state = stateOf(sessionId)
  state.toolHits.add(toolKey(name, phase))
  state.toolName = name
  return state
}

/** 命中次数（设置页展示）。 */
export function hitCounts (sessionId) {
  const state = peekState(sessionId)
  if (!state) return {}
  const out = {}
  for (const [id, entry] of state.injected) out[id] = entry.count
  return out
}

/**
 * 按会话分组的命中次数。
 *
 * 修复点：旧实现只暴露「Map 插入顺序最后一个会话」的计数，多会话时会张冠李戴。
 * 这里返回全部会话，由调用方挑「当前会话」或做汇总。
 */
export function hitCountsBySession () {
  const out = {}
  for (const [sessionId, state] of sessions) {
    if (!sessionId) continue
    const counts = {}
    for (const [id, entry] of state.injected) counts[id] = entry.count
    if (Object.keys(counts).length > 0) out[sessionId] = counts
  }
  return out
}

/**
 * 跨会话聚合：每条规则的累计命中、涉及会话数、最近一次命中时间与回合。
 * 统计随会话淘汰一起丢失（会话缓存上限 64），属于内存态的已知边界。
 */
export function hitStats () {
  const out = {}
  for (const state of sessions.values()) {
    for (const [id, entry] of state.injected) {
      const item = out[id] || { total: 0, sessions: 0, lastAt: 0, lastTurn: 0 }
      item.total += entry.count
      item.sessions += 1
      if ((entry.lastAt || 0) > item.lastAt) item.lastAt = entry.lastAt || 0
      if ((entry.lastTurn || 0) > item.lastTurn) item.lastTurn = entry.lastTurn || 0
      out[id] = item
    }
  }
  return out
}

/** 最近活跃的会话 id（按 lastSeen，而不是 Map 插入顺序）。 */
export function lastActiveSessionId () {
  let best = ''
  let bestSeen = -1
  for (const [sessionId, state] of sessions) {
    if (!sessionId) continue
    const seen = state.lastSeen || 0
    if (seen > bestSeen) {
      bestSeen = seen
      best = sessionId
    }
  }
  return best
}

/** 仅供测试：清空全部缓存。 */
export function resetStates () {
  sessions.clear()
}
