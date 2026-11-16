/**
 * 最近注入记录：调试用，只存内存、重启清空。
 *
 * 为什么需要它：注入内容进入的是运行时上下文快照，而框架**只在快照文本变化时**
 * 才追加一条消息（恒定内容不重复展示）。想确认「什么时候命中了哪条规则、注入了
 * 什么原文」，看对话是不够的，这里补一份本地记录。
 *
 * 只记渲染后的注入文本（即用户自己写的规则内容），不记会话消息正文。
 */

import { TRACE_MAX_ENTRIES, TRACE_MAX_TEXT } from './constants.js'

/**
 * @typedef {object} TraceEntry
 * @property {number} at 时间戳（毫秒）
 * @property {string} sessionId 命中的会话
 * @property {string[]} rules 命中规则的名字
 * @property {string} text 渲染后的注入文本（已截断）
 * @property {number} hits 同一步内重复求值的次数（去重后累加）
 */

/** @type {TraceEntry[]} */
const entries = []

function sameRules (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 记录一次注入。同会话 + 同一组规则 + 相同文本视为「同一步内的重复求值」，只累加次数，
 * 避免一次步骤里多次 assemble 把列表刷满。
 * @param {{ sessionId?: string, rules?: Array<{ name?: string }>, text?: string, at?: number }} input
 */
export function record ({ sessionId, rules, text, at }) {
  const trimmed = String(text || '').slice(0, TRACE_MAX_TEXT)
  if (!trimmed) return
  const names = (Array.isArray(rules) ? rules : []).map((rule) => String((rule && rule.name) || ''))
  const last = entries[0]
  const when = at || Date.now()
  if (last && last.sessionId === sessionId && last.text === trimmed && sameRules(last.rules, names)) {
    last.hits += 1
    last.at = when
    return
  }
  entries.unshift({ at: when, sessionId: String(sessionId || ''), rules: names, text: trimmed, hits: 1 })
  if (entries.length > TRACE_MAX_ENTRIES) entries.length = TRACE_MAX_ENTRIES
}

/** 最近注入，新的在前（返回副本，调用方改不坏内部状态）。 */
export function list () {
  return entries.map((entry) => ({ ...entry, rules: [...entry.rules] }))
}

/** 清空记录。 */
export function clear () {
  entries.length = 0
}

/** 当前条数（测试用）。 */
export function size () {
  return entries.length
}
