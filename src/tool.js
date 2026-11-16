/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * 工具：cond_inject
 *
 * 让 Agent 一句话就能建规则：读 / 增 / 改 / 删 / 试算，全部复用设置页那一套
 * （sanitize → matchRules → renderRules），不维护第二份逻辑。
 *
 * 宿主硬契约（缺一样就静默注册失败，见 `..\问题库\踩坑警示.md` 第 11 条）：
 *   · output 必须存在且 output.render 是函数
 *   · parameters 是原生 JSON Schema（type: object + properties + additionalProperties）
 *   · output.schema 走 assertSupportedJsonSchema 子集：object 必须显式 additionalProperties
 *   · 注册必须在同步流程里完成（不要放进异步 import 之后）
 */

import { MAX_RULES } from './constants.js'
import { toolKey } from './conditions.js'
import { matchRules } from './match.js'
import { renderRules } from './render.js'
import { sanitizeRule, sanitizeRules } from './rules.js'

export const TOOL_NAME = 'cond_inject'

const CONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    type: { type: 'string', enum: ['context', 'keyword', 'turn', 'tool'] },
    op: { type: 'string', description: 'context: gte/lte/between；turn: eq/gte/lte/every' },
    value: { type: 'number', description: 'context 为百分比 0-100；turn 为回合数' },
    value2: { type: 'number', description: 'context 且 op=between 时的上界' },
    pattern: { type: 'string', description: 'keyword 条件的正则' },
    flags: { type: 'string', description: 'keyword 条件的正则标志，如 i' },
    name: { type: 'string', description: 'tool 条件的工具名' },
    phase: { type: 'string', enum: ['before', 'after'] },
  },
}

/** 单条规则的 schema，供 `rule` 与 `rules`（草稿试算）复用。 */
const RULE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'create / update 时的规则对象。conditions 留空数组表示无条件（始终注入）。',
  properties: {
    id: { type: 'string', description: 'update 时必填；create 时可省略，自动生成' },
    name: { type: 'string', description: '规则名，用于设置页与命中计数' },
    enabled: { type: 'boolean', description: '默认 true' },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['global', 'project', 'session'] },
        value: { type: 'string', description: 'project 为目录名或完整路径；session 为会话 id' },
      },
    },
    match: { type: 'string', enum: ['all', 'any'], description: 'all 全部满足；any 任一满足' },
    conditions: { type: 'array', items: CONDITION_SCHEMA },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '注入内容，可用 {{percent}} {{turn}} {{userText}} 等占位符' },
        once: { type: 'boolean', description: '每会话只注入一次' },
        cooldownTurns: { type: 'number', description: '命中后 N 个回合内不再触发' },
      },
    },
  },
}

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'get', 'create', 'update', 'delete', 'preview'],
      description: 'list 列规则摘要；get 按 id 取全文；create 新增；update 按 id 覆盖；delete 按 id 删除；preview 用假状态试算。',
    },
    rule: RULE_SCHEMA,
    rules: {
      type: 'array',
      items: RULE_SCHEMA,
      description: '仅 preview 用：拿这组草稿规则试算，不落盘。不传则用当前规则表。',
    },
    id: { type: 'string', description: 'delete / get 时的规则 id' },
    preview: {
      type: 'object',
      additionalProperties: false,
      description: 'preview 时的假状态，不传则用默认值（占用 85 / 回合 3）。',
      properties: {
        percent: { type: 'number' },
        turn: { type: 'number' },
        userText: { type: 'string' },
        tool: { type: 'string' },
      },
    },
  },
}

/** 试算用的假会话状态，与 routes 的 previewState 保持同一语义。 */
function fakeState (input) {
  const src = input && typeof input === 'object' ? input : {}
  const percent = Number(src.percent)
  const turn = Number(src.turn)
  const tool = typeof src.tool === 'string' ? src.tool.trim() : ''
  const toolHits = new Set()
  if (tool) {
    toolHits.add(toolKey(tool, 'before'))
    toolHits.add(toolKey(tool, 'after'))
  }
  return {
    sessionId: 'preview',
    cwd: typeof src.cwd === 'string' ? src.cwd : '',
    turn: Number.isFinite(turn) ? turn : 3,
    step: 1,
    userText: typeof src.userText === 'string' ? src.userText : '',
    percent: Number.isFinite(percent) ? percent : 85,
    usedTokens: null,
    remainingTokens: null,
    toolHits,
    toolName: tool,
    injected: new Map(),
  }
}

/**
 * 未显式指定作用域时的默认值：**当前会话**。
 *
 * 这条是硬规则——在 A 项目说一句「上下文 70% 时提醒我收尾」，不该让 C 项目也收到。
 * 逐级退让：会话 → 项目（有 cwd 时）→ null（由调用方拒绝创建并提示显式指定）。
 * 绝不静默退到 global。
 */
export function defaultScope (ctx) {
  const agent = ctx && ctx.agent
  const session = agent && agent.session
  const sessionId = session && typeof session.id === 'string' ? session.id : ''
  if (sessionId) return { type: 'session', value: sessionId }
  const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
  if (cwd) return { type: 'project', value: cwd }
  return null
}

/**
 * @param {object} deps
 * @param {() => Settings} deps.getSettings
 * @param {(next: object) => void} deps.setSettings
 * @param {(next: object) => boolean} deps.persist
 * @param {Logger} deps.log
 */
export function createToolDefinition ({ getSettings, setSettings, persist, log: _log }) {
  const execute = async (args, ctx) => {
    const action = args && typeof args.action === 'string' ? args.action : ''
    const current = getSettings()

    if (action === 'list') {
      // 只给摘要：20 条规则 × 2000 字全文会把工具结果撑爆，
      // 需要全文时按 id 单独取（见 `get`）
      return {
        ok: true,
        enabled: current.enabled,
        count: current.rules.length,
        rules: current.rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled !== false,
          scope: rule.scope,
          match: rule.match,
          conditions: rule.conditions.map((cond) => cond.type),
          textPreview: String(rule.action.text || '').slice(0, 80),
          textLength: String(rule.action.text || '').length,
          once: rule.action.once === true,
          cooldownTurns: rule.action.cooldownTurns || 0,
        })),
      }
    }

    if (action === 'get') {
      const id = args && typeof args.id === 'string' ? args.id : ''
      if (!id) return { ok: false, error: 'get 需要 id' }
      const rule = current.rules.find((item) => item.id === id)
      if (!rule) return { ok: false, error: `没有 id 为 ${id} 的规则` }
      return { ok: true, rule }
    }

    if (action === 'preview') {
      // 允许用草稿规则试算，不传就用当前规则表
      const rules = Array.isArray(args.rules) ? sanitizeRules(args.rules) : current.rules
      const state = fakeState(args.preview)
      const matched = matchRules(rules, state)
      return {
        ok: true,
        matched: matched.map((r) => ({ id: r.id, name: r.name })),
        text: renderRules(matched, state, state.toolName),
      }
    }

    if (action === 'delete') {
      const id = args && typeof args.id === 'string' ? args.id : ''
      if (!id) return { ok: false, error: 'delete 需要 id' }
      if (!current.rules.some((rule) => rule.id === id)) return { ok: false, error: `没有 id 为 ${id} 的规则` }
      const next = { ...current, rules: current.rules.filter((rule) => rule.id !== id) }
      // 先落盘再改内存：反过来的话写失败后界面显示已删、磁盘还在，重启就"复活"
      if (!persist(next)) return { ok: false, error: '写入失败，见 DSH 日志' }
      setSettings(next)
      return { ok: true, deleted: id, count: next.rules.length }
    }

    if (action === 'create' || action === 'update') {
      const raw = args && args.rule
      if (!raw || typeof raw !== 'object') return { ok: false, error: 'create / update 需要 rule 对象' }

      // 作用域解析：显式给了就用它；没给就落到「当前会话」。
      // update 缺省时沿用原规则的 scope——只改文案不该把作用域悄悄放宽或收窄。
      const explicitScope = raw.scope && typeof raw.scope === 'object' && raw.scope.type ? raw.scope : null
      // 显式写了 project / session 却没给 value 时，sanitizeScope 会退成 global——
      // 那是把范围放大，正好和用户的意图相反，这里直接拒绝。
      if (explicitScope && explicitScope.type !== 'global') {
        const value = typeof explicitScope.value === 'string' ? explicitScope.value.trim() : ''
        if (!value) {
          return {
            ok: false,
            error: `scope.type="${explicitScope.type}" 需要同时给 scope.value（${explicitScope.type === 'session' ? '会话 id' : '项目目录名或路径'}）。`,
          }
        }
      }
      let candidateScope = explicitScope
      if (!candidateScope && action === 'update') {
        const id = typeof raw.id === 'string' ? raw.id : ''
        const existing = current.rules.find((rule) => rule.id === id)
        if (existing) candidateScope = existing.scope
      }
      if (!candidateScope) {
        candidateScope = defaultScope(ctx)
        if (!candidateScope) {
          return {
            ok: false,
            error: '拿不到当前会话，无法确定作用域。请显式传 scope：session（本会话）/ project（当前项目）/ global（所有会话）。',
          }
        }
      }

      const candidate = sanitizeRule({ ...raw, scope: candidateScope }, current.rules.length)
      if (!candidate) {
        return {
          ok: false,
          error: '规则无效：需要至少一个条件（或留空 conditions 表示无条件）与渲染用的 action.text',
        }
      }

      let rules
      if (action === 'update') {
        const id = typeof raw.id === 'string' ? raw.id : ''
        if (!id) return { ok: false, error: 'update 需要 rule.id' }
        const index = current.rules.findIndex((rule) => rule.id === id)
        if (index < 0) return { ok: false, error: `没有 id 为 ${id} 的规则` }
        rules = current.rules.map((rule, i) => (i === index ? { ...candidate, id } : rule))
      } else {
        if (current.rules.length >= MAX_RULES) return { ok: false, error: `规则上限 ${MAX_RULES} 条` }
        // 避免 id 撞车：新建时若没给 id 或与现有重复，重新生成（生成结果也要查重）
        const taken = new Set(current.rules.map((rule) => rule.id))
        let id = candidate.id && !taken.has(candidate.id) ? candidate.id : ''
        if (!id) {
          let seq = 0
          do {
            id = `r-${Date.now().toString(36)}-${current.rules.length}-${seq++}`
          } while (taken.has(id))
        }
        rules = [...current.rules, { ...candidate, id }]
      }

      const next = { ...current, rules }
      // 先落盘再改内存（同上：避免"界面说有、磁盘没有"）
      if (!persist(next)) return { ok: false, error: '写入失败，见 DSH 日志' }
      setSettings(next)
      const saved = action === 'update'
        ? rules.find((rule) => rule.id === raw.id)
        : rules[rules.length - 1]
      return { ok: true, rule: saved, count: rules.length }
    }

    return { ok: false, error: `未知 action：${action || '(空)'}` }
  }

  return {
    name: TOOL_NAME,
    description: [
      '管理「条件规则」规则：满足条件时自动把一段话注入对话。',
      '条件类型：context（上下文占用 %）、keyword（用户消息正则）、turn（回合数）、tool（工具调用前/后）；',
      'match 取 "all"（全部满足）或 "any"（任一满足），conditions 留空数组表示无条件、始终注入。',
      '注入文本可用 {{percent}} {{used}} {{remaining}} {{turn}} {{step}} {{userText}} {{tool}} {{ruleName}}。',
      '【作用域默认规则，务必遵守】不传 scope 时自动落到「当前会话」，这是默认且推荐的做法。',
      '只有用户明确说「全局 / 所有会话 / 所有项目」才传 {"type":"global"}；',
      '只有用户明确说「这个项目 / 当前项目」才传 {"type":"project","value":"项目目录名或路径"}。',
      '用户没提范围时不要自作主张放宽，否则在 A 项目建的规则会干扰 B、C 项目。',
      'update 时若没传 scope，沿用原规则的作用域。',
      '推荐流程：先 action:"preview" 用假状态确认会命中，再 action:"create"。',
    ].join(' '),
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute,
  }
}
