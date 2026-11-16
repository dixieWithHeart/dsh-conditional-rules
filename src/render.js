/** @typedef {import('./types.js').Rule} Rule */

/**
 * 注入文本的变量渲染。
 *
 * 未知变量原样保留（不抛错、不置空）——一条规则写错变量名，代价应该是
 * 那一段不替换，而不是整页注入失败。
 */

import { MAX_RENDER_CHARS } from './constants.js'

const VAR_RE = /\{\{(\w+)\}\}/g

/** 易读的数字：12345 → 12.3k，1234567 → 1.23M。null / 非法值给破折号。 */
export function humanTokens (value) {
  // Number(null) 是 0，会把它错显示成 "0"——先挡掉空值
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
}

/**
 * 渲染一条注入文本。
 * @param {string} template 原始文本
 * @param {object} vars 变量表，缺的键按未知处理
 * @returns {string}
 */
export function renderText (template, vars) {
  const src = typeof template === 'string' ? template : ''
  if (!src) return ''
  const out = src.replace(VAR_RE, (whole, name) => {
    if (!vars || !(name in vars)) return whole
    const value = vars[name]
    return value === null || value === undefined ? whole : String(value)
  })
  return out.length > MAX_RENDER_CHARS ? out.slice(0, MAX_RENDER_CHARS) + '…' : out
}

/** 由会话状态生成模板变量表。 */
export function buildVars (state, rule, toolName) {
  const s = state || {}
  const percent = typeof s.percent === 'number' ? s.percent : null
  return {
    percent: percent === null ? '—' : percent.toFixed(1).replace(/\.0$/, ''),
    used: humanTokens(s.usedTokens),
    remaining: humanTokens(s.remainingTokens),
    turn: typeof s.turn === 'number' ? s.turn : 0,
    step: typeof s.step === 'number' ? s.step : 0,
    userText: typeof s.userText === 'string' ? s.userText : '',
    tool: toolName || '',
    ruleName: rule ? rule.name : '',
  }
}

/** 属性值转义：规则名会进 `rule="..."`，引号与尖括号必须转掉。 */
export function escapeAttr (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 正文转义：只挡「伪造本插件标签」这一种情况。
 *
 * 不做全量 HTML 转义——规则里写的 `<div>` 之类应该原样留给模型看。
 * 但 `<conditional-inject` / `</conditional-inject` 必须失效，否则用户内容
 * 能提前闭合标签，把后面的正文伪装成「插件注入之外」的内容。
 */
export function escapeBody (value) {
  return String(value == null ? '' : value).replace(/<\s*(\/?)\s*conditional-inject/gi, '&lt;$1conditional-inject')
}

/**
 * 把多条命中规则渲染成一段运行时上下文。
 *
 * 每条规则一个 `<conditional-inject rule="名称">` 块：模型据此能分辨来源，
 * 也能归因到具体规则。外层还有框架加的 `<system-reminder>`，两层叠加。
 *
 * @param {Rule[]} matched 命中的规则
 * @param {any} state 会话状态（宿主给的快照，边界未知）
 * @param {string} toolName 触发工具名（可选）
 * @returns {string} 空串表示本次不注入
 */
export function renderRules (matched, state, toolName) {
  if (!Array.isArray(matched) || matched.length === 0) return ''
  // 不加「每轮变化的标识」：快照是整段比较、整段发送，任何一条变化都会让宿主的
  // 固定条目（工作目录 / 沙箱策略等）跟着重复一遍。可见性交给 trace，不靠改文本。
  const blocks = []
  for (const rule of matched) {
    const text = renderText(rule.action && rule.action.text, buildVars(state, rule, toolName)).trim()
    if (!text) continue
    blocks.push(`<conditional-inject rule="${escapeAttr(rule.name)}">\n${escapeBody(text)}\n</conditional-inject>`)
  }
  if (blocks.length === 0) return ''
  const joined = blocks.join('\n')
  if (joined.length <= MAX_RENDER_CHARS) return joined
  // 截断时必须补回闭合标签，否则模型看到的是一段没有结尾的标签
  return joined.slice(0, MAX_RENDER_CHARS) + '\n…（内容已截断）\n</conditional-inject>'
}
