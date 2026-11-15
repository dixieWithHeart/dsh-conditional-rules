/**
 * 规则表的读取、校验与持久化。
 *
 * 校验是白名单式的：未知字段丢弃、类型不对丢弃、数量超限截断，**不抛错**。
 * 理由：规则由用户在设置页编辑，写坏一条不该让整页失效；真正致命的（不是对象）
 * 才回退到默认值并记日志。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CONDITION_TYPES, DEFAULTS, MATCH_MODES, MAX_RULES, MAX_TEXT_LENGTH, SCOPE_TYPES, SETTINGS_FILENAME,
} from './constants.js'

export function settingsPath () {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, SETTINGS_FILENAME)
}

function str (value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function num (value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 校验单条条件；不认识就返回 null（该条被丢弃）。 */
export function sanitizeCondition (raw) {
  if (!raw || typeof raw !== 'object') return null
  const type = CONDITION_TYPES.includes(raw.type) ? raw.type : null
  if (!type) return null

  if (type === 'context') {
    const op = ['gte', 'lte', 'between'].includes(raw.op) ? raw.op : 'gte'
    const value = Math.min(100, Math.max(0, num(raw.value)))
    const out = { type, op, value }
    if (op === 'between') out.value2 = Math.min(100, Math.max(0, num(raw.value2)))
    return out
  }

  if (type === 'keyword') {
    const pattern = str(raw.pattern, 200)
    if (!pattern) return null
    // 先验编译：非法正则直接丢弃，避免每步求值时抛错
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern)
    } catch {
      return null
    }
    const flags = str(raw.flags, 5).replace(/[^gimsuy]/g, '')
    return { type, pattern, flags }
  }

  if (type === 'turn') {
    const op = ['eq', 'gte', 'lte', 'every'].includes(raw.op) ? raw.op : 'gte'
    return { type, op, value: Math.max(0, Math.round(num(raw.value))) }
  }

  // tool
  const name = str(raw.name, 120)
  if (!name) return null
  return { type, name, phase: raw.phase === 'after' ? 'after' : 'before' }
}

function sanitizeScope (raw) {
  const type = raw && SCOPE_TYPES.includes(raw.type) ? raw.type : 'global'
  if (type === 'global') return { type }
  const value = str(raw && raw.value, 400)
  // 声明了 project / session 却没给值，等同于全局，避免规则永不命中
  return value ? { type, value } : { type: 'global' }
}

/** 校验单条规则；不合法返回 null。 */
export function sanitizeRule (raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  // 条件允许为空：空条件 = 无条件，始终命中（常驻注入）。
  // 但仍要求有注入文本，否则这条规则没有任何效果。
  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions.map(sanitizeCondition).filter(Boolean).slice(0, 8)
    : []
  // 声明了条件却一条都无法识别 → 整条规则不合法。
  // 若退化成「无条件」，一次误存就把「工具触发」变成「每步注入」，属语义反转
  // （2026-11-15 用户实测：把条件切成工具/关键字触发后规则自动变无条件）。
  if (Array.isArray(raw.conditions) && raw.conditions.length > 0 && conditions.length === 0) return null
  const text = str(raw.action && raw.action.text, MAX_TEXT_LENGTH)
  if (!text.trim()) return null

  return {
    id: str(raw.id, 60) || `r-${index}-${Date.now().toString(36)}`,
    name: str(raw.name, 60) || `规则 ${index + 1}`,
    enabled: raw.enabled !== false,
    scope: sanitizeScope(raw.scope),
    match: MATCH_MODES.includes(raw.match) ? raw.match : 'all',
    conditions,
    action: {
      text,
      once: raw.action.once === true,
      cooldownTurns: Math.max(0, Math.round(num(raw.action.cooldownTurns))),
    },
  }
}

/** 合并 patch 配置与默认值，并对规则表做完整校验。 */
export function resolveOptions (raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError(`${'dsh-conditional-rules'}: config must be a mapping`)
  }
  const source = raw || {}
  return {
    enabled: source.enabled !== false,
    version: DEFAULTS.version,
    rules: sanitizeRules(source.rules),
  }
}

export function sanitizeRules (raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitizeRule).filter(Boolean).slice(0, MAX_RULES)
}

/**
 * 就地合并一次 patch 到当前设置。
 * 只支持两条：`enabled` 与 `rules`（后者整表覆盖）。设置页每次提交的都是整张表，
 * 不做「按 id 局部改一条」——那需要额外维护合并语义，收益不抵复杂度。
 */
export function sanitize (patch, current) {
  const next = { ...current }
  if (!patch || typeof patch !== 'object') return next
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (Array.isArray(patch.rules)) next.rules = sanitizeRules(patch.rules)
  return next
}

export function loadSettings (log, defaults) {
  try {
    const file = settingsPath()
    // 设置文件不存在时用 patch 提供的默认值（含 rules），不能把 rules 清空——
    // 那会让 cordis.patch.yml 里声明的规则永远不生效
    if (!fs.existsSync(file)) return { ...defaults }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('settings file is not an object, using defaults')
      return { ...defaults }
    }
    return {
      enabled: parsed.enabled !== false,
      version: DEFAULTS.version,
      rules: sanitizeRules(parsed.rules),
    }
  } catch (error) {
    log.warn(`settings load failed: ${error && error.message ? error.message : error}`)
    return { ...defaults }
  }
}

export function saveSettings (log, settings) {
  try {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
    return true
  } catch (error) {
    log.warn(`settings save failed: ${error && error.message ? error.message : error}`)
    return false
  }
}
