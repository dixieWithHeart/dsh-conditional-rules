/**
 * 条件规则的配置契约（仅类型，无运行时代码）。
 *
 * 用途：让 `tsc --checkJs` 能检查 `settings.rules` 这类访问，而不是一律报
 * 「Property 'rules' does not exist on type 'object'」。
 * 运行时校验的唯一来源仍是 `src/rules.js` 的 sanitize*（白名单过滤），本文件不参与运行。
 */

export interface Condition {
  type: 'context' | 'keyword' | 'turn' | 'tool'
  /** context / turn 的比较方式 */
  op?: 'gte' | 'lte' | 'between' | 'eq' | 'every'
  /** context 百分比 或 turn 数值 */
  value?: number
  /** context 的 between 上界 */
  value2?: number
  /** keyword 正则 */
  pattern?: string
  /** keyword 标志（gimsuy 子集） */
  flags?: string
  /** tool 名称 */
  name?: string
  /** tool 触发阶段 */
  phase?: 'before' | 'after'
}

export interface RuleScope {
  type: 'global' | 'project' | 'session'
  /** project 目录名/路径，或 session id；global 时缺省 */
  value?: string
}

export interface RuleAction {
  text: string
  once: boolean
  cooldownTurns: number
}

export interface Rule {
  id: string
  name: string
  enabled: boolean
  scope: RuleScope
  match: 'all' | 'any'
  conditions: Condition[]
  action: RuleAction
}

export interface Settings {
  enabled: boolean
  version: number
  rules: Rule[]
}

/** 路由 / 工具共用的最小日志接口。 */
export interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}
