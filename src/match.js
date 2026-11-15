/**
 * 规则命中判定：作用域 → 条件组合 → once / cooldown。
 * 纯函数，不修改传入状态；命中记录由调用方按返回值更新。
 */

import { evalCondition } from './conditions.js'

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** 作用域是否匹配当前会话。 */
export function scopeMatches (scope, state) {
  if (!scope || scope.type === 'global') return true
  if (scope.type === 'session') {
    return Boolean(state && state.sessionId && state.sessionId === scope.value)
  }
  if (scope.type === 'project') {
    const cwd = state && typeof state.cwd === 'string' ? state.cwd : ''
    if (!cwd) return false
    // 完整路径直接比；只写目录名时按尾部匹配（大小写与斜杠方向不敏感）
    const target = norm(scope.value)
    const actual = norm(cwd)
    if (actual === target) return true
    const leaf = target.replace(/^.*\//, '')
    return leaf.length > 0 && actual.endsWith('/' + leaf)
  }
  return false
}

/**
 * 条件组合。all = AND；any = OR。
 * 空条件组视为「无条件」——始终命中。这是常驻注入的写法，
 * 内容不变时框架不会重复追加，所以它不等于每轮都占 token。
 *
 * conditions 不是数组（脏配置）时判为不命中：不能把坏数据当成「无条件」，
 * 那会让一条本该无效的规则变成每步都注入。
 */
export function conditionsMatch (rule, state) {
  if (!Array.isArray(rule.conditions)) return false
  const list = rule.conditions
  if (list.length === 0) return true
  const results = list.map((cond) => evalCondition(cond, state))
  return rule.match === 'any' ? results.some(Boolean) : results.every(Boolean)
}

/**
 * once / cooldown 是否仍然允许触发。
 *
 * 关键一条：**本回合已经命中过的规则继续允许**。`assemble()` 在同一步里可能被调用多次
 * （组装 + 准入刷新），如果第二次因为 once 生效而返回空串，框架会认为上下文变空并改写快照。
 * 同回合幂等由 noteHit 保证，这里只负责跨回合的抑制。
 */
function allowedByHistory (rule, state) {
  const entry = state && state.injected && typeof state.injected.get === 'function'
    ? state.injected.get(rule.id)
    : null
  if (!entry || !entry.count) return true
  const turn = typeof state.turn === 'number' ? state.turn : 0
  if (entry.lastTurn === turn) return true
  if (rule.action.once) return false
  const cooldown = rule.action.cooldownTurns || 0
  if (cooldown > 0 && turn - entry.lastTurn < cooldown) return false
  return true
}

/**
 * 判断一条规则是否命中。
 * @param {object} rule 已校验规则
 * @param {object} state 会话状态快照
 * @returns {boolean}
 */
export function ruleMatches (rule, state) {
  if (!rule || rule.enabled === false) return false
  if (!scopeMatches(rule.scope, state)) return false
  if (!allowedByHistory(rule, state)) return false
  return conditionsMatch(rule, state)
}

/** 全部命中的规则（保序）。 */
export function matchRules (rules, state) {
  if (!Array.isArray(rules)) return []
  return rules.filter((rule) => ruleMatches(rule, state))
}
