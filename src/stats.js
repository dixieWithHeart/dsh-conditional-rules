/**
 * 命中统计（持久化）。
 *
 * 与会话内存统计（session-state.js）的分工：
 *   · session-state 的 injected → 运行时判定（once / cooldown），每会话、易丢
 *   · 这里的 stats → 展示与追溯，跨会话、跨重启，写独立文件
 *
 * 文件：与设置文件同目录，`dsh-conditional-rules-stats.json`
 * 写入：命中后标脏，2 秒节流合并落盘；插件卸载时由 index.js 调 flushStats()
 * 幂等：按「同一规则在同一会话的同一回合只记一次」去重（键为 `会话:回合`）
 */

import fs from 'node:fs'
import path from 'node:path'

import { settingsPath } from './rules.js'

const STATS_VERSION = 1
/** 每条规则保留的最近命中明细条数。 */
const MAX_EVENTS = 30
/** 每条规则记录的会话数上限（去重数组）。 */
const MAX_SESSIONS = 50
/** 落盘节流窗口（毫秒）。 */
const SAVE_DELAY = 2000

function statsPath () {
  return settingsPath().replace(/\.json$/, '-stats.json')
}

let data = { version: STATS_VERSION, rules: {} }
let timer = null
let dirty = false
let logger = null

function ensure (ruleId) {
  let item = data.rules[ruleId]
  if (!item) {
    item = { name: '', total: 0, sessions: [], lastAt: 0, lastTurn: 0, lastKey: '', events: [] }
    data.rules[ruleId] = item
  }
  return item
}

/** 从磁盘载入；文件不存在或损坏时退回空统计（不阻塞插件启动）。 */
export function loadStats (log) {
  logger = log || null
  // 载入前先清掉可能挂着的节流定时器：否则旧 timer 会在新数据上再 flush 一次
  if (timer) { clearTimeout(timer); timer = null }
  dirty = false
  const file = statsPath()
  try {
    if (!fs.existsSync(file)) {
      data = { version: STATS_VERSION, rules: {} }
      return
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.rules || typeof parsed.rules !== 'object') {
      data = { version: STATS_VERSION, rules: {} }
      return
    }
    data = { version: STATS_VERSION, rules: {} }
    for (const [id, raw] of Object.entries(parsed.rules)) {
      if (!raw || typeof raw !== 'object') continue
      const total = Number(raw.total)
      data.rules[id] = {
        name: typeof raw.name === 'string' ? raw.name : '',
        total: Number.isFinite(total) && total > 0 ? Math.round(total) : 0,
        sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => typeof s === 'string').slice(0, MAX_SESSIONS) : [],
        lastAt: Number.isFinite(Number(raw.lastAt)) ? Number(raw.lastAt) : 0,
        lastTurn: Number.isFinite(Number(raw.lastTurn)) ? Number(raw.lastTurn) : 0,
        lastKey: typeof raw.lastKey === 'string' ? raw.lastKey : '',
        events: Array.isArray(raw.events)
          ? raw.events
            .filter((e) => e && typeof e === 'object')
            .slice(0, MAX_EVENTS)
            .map((e) => ({
              at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0,
              sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
              turn: Number.isFinite(Number(e.turn)) ? Number(e.turn) : 0,
            }))
          : [],
      }
    }
  } catch (error) {
    data = { version: STATS_VERSION, rules: {} }
    if (logger) logger.warn(`stats load failed: ${error && error.message ? error.message : error}`)
  }
}

function flush () {
  if (timer) { clearTimeout(timer); timer = null }
  const file = statsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    dirty = false
    return true
  } catch (error) {
    if (logger) logger.warn(`stats save failed: ${error && error.message ? error.message : error}`)
    return false
  }
}

function scheduleSave () {
  dirty = true
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    if (dirty) flush()
  }, SAVE_DELAY)
}

/**
 * 记一次命中（同一规则同一回合只记一次，调用方无需去重）。
 * @param {string} sessionId
 * @param {Array<{ id?: string, name?: string }>} rules
 * @param {number} turn
 */
export function recordHit (sessionId, rules, turn) {
  if (!Array.isArray(rules) || rules.length === 0) return
  const now = Date.now()
  const t = Number.isFinite(turn) ? turn : 0
  let changed = false
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id) continue
    const item = ensure(rule.id)
    // 去重键必须是「会话 + 回合」：不同会话可以同时处于 turn 1，只按回合号会误合并
    const key = (sessionId || '') + ':' + t
    if (item.lastKey === key && item.total > 0) continue
    item.name = typeof rule.name === 'string' ? rule.name : item.name
    item.total += 1
    item.lastAt = now
    item.lastTurn = t
    item.lastKey = key
    if (sessionId && !item.sessions.includes(sessionId)) {
      item.sessions.unshift(sessionId)
      if (item.sessions.length > MAX_SESSIONS) item.sessions.length = MAX_SESSIONS
    }
    item.events.unshift({ at: now, sessionId: sessionId || '', turn: t })
    if (item.events.length > MAX_EVENTS) item.events.length = MAX_EVENTS
    changed = true
  }
  if (changed) scheduleSave()
}

/**
 * 看板数据：按命中次数降序；名字取统计里保存的副本（规则删掉后仍可读）。
 * @returns {import('./types.js').StatsEntry[]}
 */
export function snapshot () {
  return Object.entries(data.rules)
    .map(([id, item]) => ({
      id,
      name: item.name || id,
      total: item.total,
      sessions: item.sessions.length,
      lastAt: item.lastAt,
      events: item.events.map((e) => ({ ...e })),
    }))
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total || b.lastAt - a.lastAt)
}

/** 清空统计并立即落盘。 */
export function clearStats () {
  data = { version: STATS_VERSION, rules: {} }
  flush()
}

/** 插件卸载 / 重启前把未落盘的改动写掉。 */
export function flushStats () {
  if (timer) { clearTimeout(timer); timer = null }
  if (dirty) flush()
}

/** 仅供测试：重置内存态并清掉定时器。 */
export function resetForTest () {
  if (timer) { clearTimeout(timer); timer = null }
  dirty = false
  data = { version: STATS_VERSION, rules: {} }
}
