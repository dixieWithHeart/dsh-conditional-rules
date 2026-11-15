/**
 * 条件规则 —— 装配层。
 *
 * 一条链路：
 *   事件 → 会话状态缓存 → text() 求值 → ctx.systemPrompt.context() → 运行时上下文快照
 *
 * 装配纪律（与项目其他插件一致）：
 *   1. 可选服务判断存在性，缺一个不能把其他注册一起带走
 *   2. 所有注册放进 ctx.effect 并返回清理函数
 *   3. 不做「enabled=false 就 apply 早退」：路由与设置页要始终可用
 *   4. text() 必须同步且只读内存：每步都会被调用，不能读盘、不能 await
 *
 * @module dsh-conditional-rules
 */

import {
  CONTEXT_NAME, CONTEXT_ORDER, NOTICE_CONTEXT_NAME, NOTICE_CONTEXT_ORDER, NOTICE_TEXT, VERSION,
} from './src/constants.js'
import { matchRules } from './src/match.js'
import { renderRules } from './src/render.js'
import { createRoutes } from './src/routes.js'
import { loadSettings, resolveOptions, saveSettings, settingsPath } from './src/rules.js'
import {
  allStates, hitCounts, noteHit, notePreStep, noteSessionEvent, noteTool, sessionIdOf, stateOf,
} from './src/session-state.js'
import { createToolDefinition } from './src/tool.js'

export const name = 'dsh-conditional-rules'

/** tools 是给 Agent 用的配置通道；systemPrompt 是注入载体。webServer 缺失时只是没有设置页路由。 */
export const inject = ['systemPrompt', 'tools']

/** 从本步消息里取最后一条「用户撰写」的文本。 */
function lastUserText (messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || !message.source || message.source.kind !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
      if (text) return text
    }
  }
  return ''
}

export function apply (ctx, config) {
  const log = ctx.logger('conditional-inject')
  let settings = loadSettings(log, resolveOptions(config))
  if (!settings.enabled) log.info('条件规则已在设置中关闭，设置页仍可用')

  const getSettings = () => settings
  const setSettings = (next) => { settings = next }

  // ── 会话状态：事件写入，text() 只读 ──────────────────────────────────
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
      try {
        const sessionId = agent && agent.session && agent.session.id ? agent.session.id : ''
        if (sessionId) {
          // 工作目录在 session.header.cwd（Session 本身没有 cwd 字段），
          // 取错会让 project 作用域永远不命中
          const session = agent.session
          const cwd = (session.header && session.header.cwd) || ''
          notePreStep(sessionId, { step, userText: lastUserText(messages), cwd })
        }
      } catch (error) {
        log.warn(`pre-step state failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // 不拥有决策：必须把 next() 的结果原样交回
      return next()
    }), 'conditional-inject-pre-step')

    ctx.effect(() => ctx.on('session/event', (session, event) => {
      try {
        const id = session && typeof session.id === 'string' ? session.id : ''
        if (id) noteSessionEvent(id, event)
      } catch (error) {
        log.warn(`session event state failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }), 'conditional-inject-session-event')

    // tools/pre-execute 是 waterfall：必须 return next()，否则框架读到 undefined.kind 直接崩，
    // 而且会让**所有工具调用**失败（不只是本插件的）。观察者只记状态，不干预决策。
    // exec 的契约是 ToolExecutionInput：工具名在顶层 name（没有 exec.tool 字段），
    // 会话走 exec.agent.session。
    ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
        const toolName = exec && typeof exec.name === 'string' ? exec.name : ''
        if (sessionId) noteTool(sessionId, toolName, 'before')
      } catch (error) {
        log.warn(`tool pre state failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    }), 'conditional-inject-tool-pre')

    // tools/post-execute 同样是 waterfall，签名是 (exec, result, next)
    ctx.effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
        const toolName = exec && typeof exec.name === 'string' ? exec.name : ''
        if (sessionId) noteTool(sessionId, toolName, 'after')
      } catch (error) {
        log.warn(`tool post state failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    }), 'conditional-inject-tool-post')
  } else {
    log.warn('ctx.on 不可用：条件规则退化为静态求值')
  }

  // ── 运行时上下文段 ──────────────────────────────────────────────────
  const prompt = ctx.systemPrompt
  if (!prompt || typeof prompt.context !== 'function') {
    log.warn('systemPrompt.context 不可用：注入未注册')
  } else {
    ctx.effect(() => prompt.context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      // 关闭插值：{{percent}} 这类的处理权在我们自己手里，交给框架会在遇到
      // 未注册变量时抛错（renderPrompt 对未知引用抛出）
      interpolate: false,
      text: (assembleContext) => {
        try {
          const current = settings
          if (!current.enabled || current.rules.length === 0) return ''
          const sessionId = sessionIdOf(assembleContext)
          if (!sessionId) return ''
          const state = stateOf(sessionId)
          const matched = matchRules(current.rules, state)
          if (matched.length === 0) return ''
          // 幂等登记：同回合内多次 assemble 结果恒定，跨回合才由 once/cooldown 抑制
          noteHit(sessionId, matched)
          return renderRules(matched, state, state.toolName)
        } catch (error) {
          log.warn(`context render failed: ${error instanceof Error ? error.message : String(error)}`)
          return ''
        }
      },
    }), 'conditional-inject-context')

    // 约定段：只告诉模型「这个标签是什么」，不含任何规则内容。
    // 走 context 而非 section：persona 的 complete: true 会让装配只保留那一个 section，
    // 插件 section 全部被丢弃（2026-11-15 实测，详见 constants.js 的同名注释）。
    // 没有启用规则时返回空串，框架的 renderContextSections 会过滤掉空文本，不给不用的人加噪音。
    ctx.effect(() => prompt.context({
      name: NOTICE_CONTEXT_NAME,
      order: NOTICE_CONTEXT_ORDER,
      // 至少要有一条启用的规则才有注入可言；全部停用时同样不加噪音
      text: () => (
        settings.enabled && settings.rules.some((rule) => rule.enabled !== false) ? NOTICE_TEXT : ''
      ),
    }), 'conditional-inject-notice')
  }

  // ── Agent 工具：一句话建规则 ────────────────────────────────────────
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    log.warn('tools 服务不可用：cond_inject 未注册')
  } else {
    ctx.effect(() => {
      try {
        const dispose = ctx.tools.register(createToolDefinition({
          getSettings,
          setSettings,
          persist: (next) => saveSettings(log, next),
          log,
        }))
        log.info('cond_inject tool registered')
        return dispose
      } catch (error) {
        log.warn(`tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }, 'conditional-inject-tool')
  }

  // ── 设置页路由 ──────────────────────────────────────────────────────
  if (typeof ctx.inject !== 'function') {
    log.warn('webServer 不可用：设置页路由未注册')
  } else {
    ctx.inject(['webServer'], (wctx) => {
      const server = wctx && wctx.webServer
      if (!server || typeof server.register !== 'function') {
        log.warn('webServer 缺失：设置页路由未注册')
        return
      }
      // 注册挂在 webServer 的上下文上，随它一起释放
      wctx.effect(() => {
        const routes = createRoutes({
          getSettings,
          setSettings,
          persist: (next) => saveSettings(log, next),
          sessionSummary: () => {
            const states = allStates()
            const sessionId = states.length > 0 ? states[states.length - 1].sessionId : ''
            return {
              sessions: states.map((state) => ({
                sessionId: state.sessionId,
                turn: state.turn,
                percent: typeof state.percent === 'number' ? Number(state.percent.toFixed(1)) : null,
              })),
              hits: sessionId ? hitCounts(sessionId) : {},
            }
          },
          log,
        })
        // 路由兜底：未捕获异常转 500，既不让请求挂起，也不冒泡到宿主进程
        const guard = (handler) => async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            log.warn(`route failed: ${error instanceof Error ? error.message : String(error)}`)
            try {
              if (res.headersSent) {
                res.end()
              } else {
                res.writeHead(500, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: 'plugin internal error' }))
              }
            } catch { /* 连接已断，忽略 */ }
          }
        }
        const disposers = routes.map((route) => {
          try {
            return server.register({ ...route, handler: guard(route.handler) })
          } catch (error) {
            // 单条路由注册失败不该连累其它路由
            log.warn(`route register failed: ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
            return () => {}
          }
        })
        return () => {
          for (const dispose of disposers) {
            try { if (typeof dispose === 'function') dispose() } catch { /* 已释放 */ }
          }
        }
      })
    })
  }

  log.info(`ready v${VERSION} (settings=${settingsPath()}, rules=${settings.rules.length})`)
}
