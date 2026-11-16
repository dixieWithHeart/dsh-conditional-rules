/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * 设置页用的 HTTP 路由。
 *
 * 与本机既有插件同款，**无鉴权**：DSH 的 Web 入口本身要 token，但自注册路由
 * 不带校验。这里只放低敏感数据（规则文本、命中计数），不放会话内容。
 */

import { MAX_BODY_BYTES, ROUTE_PREFIX, VERSION } from './constants.js'
import { clearStats } from './stats.js'
import { clear as clearTrace, list as listTrace } from './trace.js'
import { toolKey } from './conditions.js'
import { matchRules } from './match.js'
import { renderRules } from './render.js'
import { sanitize, sanitizeRules } from './rules.js'

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }

async function readBody (req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY_BYTES) return null
  }
  return body
}

/** 构造一个用于试算的假会话状态。 */
function previewState (input) {
  const percent = Number(input && input.percent)
  const turn = Number(input && input.turn)
  const used = Number(input && input.usedTokens)
  const window = Number(input && input.contextWindow)
  const tool = input && typeof input.tool === 'string' ? input.tool.trim() : ''
  const toolHits = new Set()
  if (tool) {
    toolHits.add(toolKey(tool, 'before'))
    toolHits.add(toolKey(tool, 'after'))
  }
  const effectiveWindow = Number.isFinite(window) && window > 0 ? window : 1_000_000
  const effectiveUsed = Number.isFinite(used) && used > 0
    ? used
    : (Number.isFinite(percent) ? Math.round((percent / 100) * effectiveWindow) : null)
  return {
    sessionId: 'preview',
    cwd: input && typeof input.cwd === 'string' ? input.cwd : '',
    turn: Number.isFinite(turn) ? turn : 1,
    step: 1,
    userText: input && typeof input.userText === 'string' ? input.userText : '',
    percent: Number.isFinite(percent) ? percent : null,
    usedTokens: effectiveUsed,
    remainingTokens: effectiveUsed === null ? null : Math.max(0, effectiveWindow - effectiveUsed),
    contextWindow: effectiveWindow,
    toolHits,
    toolName: tool,
    injected: new Map(),
  }
}

/**
 * @param {object} deps
 * @param {() => Settings} deps.getSettings
 * @param {(next: object) => void} deps.setSettings
 * @param {(next: object) => boolean} deps.persist
 * @param {() => object} deps.sessionSummary 会话缓存摘要
 * @param {Logger} deps.log
 */
export function createRoutes ({ getSettings, setSettings, persist, sessionSummary, log }) {
  const summary = typeof sessionSummary === 'function' ? sessionSummary : () => ({ sessions: [] })

  return [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          version: VERSION,
          settings: getSettings(),
          trace: listTrace(),
          ...summary(),
        }))
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/set`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readBody(req)
        if (body === null) { res.writeHead(413); res.end(); return }

        let patch
        try {
          patch = JSON.parse(body || '{}')
        } catch {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON', settings: getSettings() }))
          return
        }

        const current = getSettings()
        const next = sanitize(patch, current)
        const changed = JSON.stringify(next) !== JSON.stringify(current)
        if (changed) {
          // 先落盘再改内存：写失败就保持原设置，避免界面显示已保存而磁盘没变
          if (!persist(next)) {
            res.writeHead(500, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '规则写入失败，见 DSH 日志', settings: getSettings() }))
            return
          }
          setSettings(next)
          log.info(`rules updated: ${next.rules.length} 条，enabled=${next.enabled}`)
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, changed, settings: getSettings() }))
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/preview`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readBody(req)
        if (body === null) { res.writeHead(413); res.end(); return }
        let input = {}
        try {
          input = JSON.parse(body || '{}')
        } catch {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
          return
        }
        // 允许直接传规则表试算（编辑中未保存的规则），否则用当前设置
        const rules = Array.isArray(input.rules) ? sanitizeRules(input.rules) : getSettings().rules
        const state = previewState(input)
        const matched = matchRules(rules, state)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          matched: matched.map((r) => r.id),
          text: renderRules(matched, state, state.toolName),
        }))
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/trace/clear`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        clearTrace()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, trace: [] }))
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stats/clear`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        clearStats()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, stats: [] }))
      },
    },
  ]
}
