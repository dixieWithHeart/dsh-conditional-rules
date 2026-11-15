/**
 * 单个条件的求值。纯函数：输入条件 + 会话状态快照，输出布尔。
 *
 * 数据不足一律视为「不命中」——宁可少注入一次，也不要在没有占用数据时
 * 把「≥80%」当成真（那会让规则在每个会话开头都触发）。
 */

/** 上下文占用条件。 */
function evalContext (cond, state) {
  const percent = state && typeof state.percent === 'number' ? state.percent : null
  if (percent === null) return false
  if (cond.op === 'gte') return percent >= cond.value
  if (cond.op === 'lte') return percent <= cond.value
  if (cond.op === 'between') {
    const lo = Math.min(cond.value, cond.value2 || 0)
    const hi = Math.max(cond.value, cond.value2 || 0)
    return percent >= lo && percent <= hi
  }
  return false
}

/**
 * 正则缓存：`text()` 每步都会被调用，逐个 `new RegExp` 是纯浪费；
 * 用户写的灾难性正则也会每次都重新编译一次。缓存上限存在，避免长期运行后无限增长。
 */
const REGEX_CACHE = new Map()
const REGEX_CACHE_MAX = 256

function compile (pattern, flags) {
  const key = flags + '\u0000' + pattern
  const cached = REGEX_CACHE.get(key)
  if (cached) return cached
  const re = new RegExp(pattern, flags)
  if (REGEX_CACHE.size >= REGEX_CACHE_MAX) REGEX_CACHE.clear()
  REGEX_CACHE.set(key, re)
  return re
}

/** 用户输入关键词条件。 */
function evalKeyword (cond, state) {
  const text = state && typeof state.userText === 'string' ? state.userText : ''
  if (!text) return false
  try {
    // 去掉 g / y：带状态的正则重复 test 会在 lastIndex 上翻车
    const flags = cond.flags ? cond.flags.replace(/[gy]/g, '') : ''
    return compile(cond.pattern, flags).test(text)
  } catch {
    return false
  }
}

/** 回合数条件。 */
function evalTurn (cond, state) {
  const turn = state && typeof state.turn === 'number' ? state.turn : 0
  if (turn <= 0) return false
  if (cond.op === 'eq') return turn === cond.value
  if (cond.op === 'gte') return turn >= cond.value
  if (cond.op === 'lte') return turn <= cond.value
  if (cond.op === 'every') return cond.value > 0 && turn % cond.value === 0
  return false
}

/** 工具条件：由事件预置的一次性标记决定，不在求值时重新扫描。 */
function evalTool (cond, state) {
  const hits = state && state.toolHits
  if (!hits || typeof hits.has !== 'function') return false
  return hits.has(`${cond.name}#${cond.phase}`)
}

const EVAL = { context: evalContext, keyword: evalKeyword, turn: evalTurn, tool: evalTool }

/**
 * @param {object} cond 已校验的条件
 * @param {object} state 会话状态快照
 * @returns {boolean}
 */
export function evalCondition (cond, state) {
  const fn = cond && EVAL[cond.type]
  return fn ? Boolean(fn(cond, state)) : false
}

/** tool 条件在生产侧用的标记键，供事件处理器与求值共用。 */
export function toolKey (name, phase) {
  return `${name}#${phase}`
}
