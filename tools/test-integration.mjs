// 集成测试：mock ctx 跑通「事件 → 状态 → text() → 注入文本」整条链路。
// 重点验证两件事：同一步内多次调用 text() 结果恒定；once 在步边界才生效。
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

// 隔离设置文件：本测试不读也不写真实 ~/.dsh
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-cond-inject-test-' + Date.now())

const { apply } = await import('../index.js')
const { resetStates, hitCountsBySession, hitStats, lastActiveSessionId } = await import('../src/session-state.js')
const { clear: clearTrace, list: listTrace } = await import('../src/trace.js')

let passed = 0
async function check (name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok  ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

const RULE = {
  id: 'r-deploy',
  name: '部署提醒',
  enabled: true,
  scope: { type: 'global' },
  match: 'all',
  conditions: [{ type: 'context', op: 'gte', value: 80 }],
  action: { text: '占用已到 {{percent}}%，请先确认是否收尾。', once: false, cooldownTurns: 0 },
}

const ONCE_RULE = {
  id: 'r-once',
  name: '一次性提醒',
  enabled: true,
  scope: { type: 'global' },
  match: 'all',
  conditions: [{ type: 'turn', op: 'gte', value: 1 }],
  action: { text: '本会话首次提醒', once: true, cooldownTurns: 0 },
}

/** 造一个够用的 ctx：记录注册项，暴露触发入口。 */
function makeCtx () {
  const handlers = new Map()
  // contexts 用数组：插件注册两段（122 注入段 + 121 约定段）。
  // 刻意不提供 section——约定段若退回 section，这里会以 "section is not a function" 变红。
  const registered = {
    contexts: [],
    routes: [],
    /** 注入段（name = conditional-inject） */
    get injectContext () { return this.contexts.find((entry) => entry.name === 'conditional-inject') },
    /** 约定段（name = conditional-inject-notice） */
    get noticeContext () { return this.contexts.find((entry) => entry.name === 'conditional-inject-notice') },
  }
  const logs = []
  const ctx = {
    logger: () => ({
      info: (...a) => logs.push('INFO ' + a.join(' ')),
      warn: (...a) => logs.push('WARN ' + a.join(' ')),
    }),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event) },
    systemPrompt: {
      context: (entry) => {
        registered.contexts.push(entry)
        return () => {
          const index = registered.contexts.indexOf(entry)
          if (index >= 0) registered.contexts.splice(index, 1)
        }
      },
    },
    inject: (services, cb) => {
      const wctx = {
        effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
        webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
      }
      const dispose = cb(wctx)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    agents: { get: () => undefined },
  }
  return { ctx, handlers, registered, logs }
}

function assemble (sessionId) {
  return { scope: { id: sessionId } }
}

async function run () {
  await check('apply 不抛错且注册了运行时上下文段', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [RULE, ONCE_RULE] })
    assert.ok(registered.injectContext, '未注册 systemPrompt.context')
    assert.equal(registered.injectContext.name, 'conditional-inject')
    // 关闭插值：{{percent}} 必须由插件自己处理
    assert.equal(registered.injectContext.interpolate, false)
  })

  await check('注册了三条设置页路由', () => {
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    const paths = registered.routes.map((r) => r.path)
    assert.ok(paths.some((p) => p.endsWith('/state')), paths.join(','))
    assert.ok(paths.some((p) => p.endsWith('/set')), paths.join(','))
    assert.ok(paths.some((p) => p.endsWith('/preview')), paths.join(','))
  })

  await check('没有规则时不注入', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    assert.equal(registered.injectContext.text(assemble('s-1')), '')
  })

  await check('总开关关闭时不注入', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: false, rules: [RULE] })
    assert.equal(registered.injectContext.text(assemble('s-a')), '')
  })

  await check('占用不足时不命中', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [RULE] })
    await handlers.get('agent/pre-step')({ agent: { session: { id: 's-b', cwd: '' } }, messages: [], step: 1 }, () => ({}))
    // 还没有 assistant/message，percent 为空 → 不命中
    assert.equal(registered.injectContext.text(assemble('s-b')), '')
  })

  await check('占用达标后命中并渲染变量', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [RULE] })
    const session = { id: 's-c', cwd: '' }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    handlers.get('session/event')(session, { type: 'request/context', data: { contextWindow: 1000 } })
    handlers.get('session/event')(session, { type: 'assistant/message', data: { usage: { inputTokens: 900 } } })
    const text = registered.injectContext.text(assemble('s-c'))
    assert.ok(text.includes('<conditional-inject'), text)
    assert.ok(text.includes('90'), text)
  })

  await check('同一步内多次调用结果恒定（once 不会自我失效）', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [ONCE_RULE] })
    const session = { id: 's-d', cwd: '' }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    const first = registered.injectContext.text(assemble('s-d'))
    const second = registered.injectContext.text(assemble('s-d'))
    const third = registered.injectContext.text(assemble('s-d'))
    assert.ok(first.includes('首次提醒'), first)
    assert.equal(second, first)
    assert.equal(third, first)
  })

  await check('once 在下一个回合不再命中', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [ONCE_RULE] })
    const session = { id: 's-e', cwd: '' }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-e')).includes('首次提醒'))
    // 同回合的后续步仍命中：否则同一步内的第二次 assemble 会看到空串
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 2 }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-e')).includes('首次提醒'), '同回合内不该静默')
    // 下一个回合才静默
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-e')), '')
  })

  await check('keyword 条件从用户消息取文本', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-kw', name: 'kw', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [{ type: 'keyword', pattern: '部署', flags: '' }],
        action: { text: '开始部署流程', once: false, cooldownTurns: 0 },
      }],
    })
    const session = { id: 's-f', cwd: '' }
    await handlers.get('agent/pre-step')({
      agent: { session },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '帮我部署到服务器' }] }],
      step: 1,
    }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-f')).includes('开始部署流程'))
  })

  await check('注入的上下文不算用户消息', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-kw2', name: 'kw', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [{ type: 'keyword', pattern: '部署', flags: '' }],
        action: { text: '开始部署流程', once: false, cooldownTurns: 0 },
      }],
    })
    const session = { id: 's-g', cwd: '' }
    await handlers.get('agent/pre-step')({
      agent: { session },
      messages: [{ source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '部署相关提示' }] }],
      step: 1,
    }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-g')), '')
  })

  await check('tool 条件：事件后命中，下一步被清掉', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-tool', name: 'tool', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [{ type: 'tool', name: 'bash', phase: 'before' }],
        action: { text: '调用了 bash', once: false, cooldownTurns: 0 },
      }],
    })
    const session = { id: 's-h', cwd: '' }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-h')), '')
    // exec 契约：工具名在顶层 name，没有 exec.tool 字段
    const exec = { name: 'bash', agent: { session } }
    await handlers.get('tools/pre-execute')(exec, () => Promise.resolve({ kind: 'allow' }))
    assert.ok(registered.injectContext.text(assemble('s-h')).includes('调用了 bash'))
    // 同回合的后续步仍能看到标记（否则同一步第二次 assemble 会丢内容）
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 2 }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-h')).includes('调用了 bash'))
    // 新回合开始才清掉
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-h')), '')
  })

  // ── 这次事故的直接原因：waterfall 观察者必须把 next() 的结果交回 ──
  await check('tools/pre-execute 把 next() 的决策原样交回', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    const allow = { kind: 'allow' }
    const out = await handlers.get('tools/pre-execute')({ name: 'bash', agent: { session: { id: 's-j' } } }, () => Promise.resolve(allow))
    assert.equal(out, allow, '返回值必须是 next() 的结果，否则框架读 undefined.kind 崩溃')
  })

  await check('tools/post-execute 把 next() 的决策原样交回', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    const accept = { kind: 'accept' }
    const out = await handlers.get('tools/post-execute')(
      { name: 'bash', agent: { session: { id: 's-k' } } },
      { isError: false },
      () => Promise.resolve(accept),
    )
    assert.equal(out, accept)
  })

  await check('hook 抛错时仍把 next() 交回（不让插件失败带走工具调用）', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    const allow = { kind: 'allow' }
    const badExec = { name: 'bash', get agent () { throw new Error('boom') } }
    const out = await handlers.get('tools/pre-execute')(badExec, () => Promise.resolve(allow))
    assert.equal(out, allow)
  })

  await check('pre-step 不拥有决策：把 next() 的结果原样交回', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    const decision = { kind: 'proceed', messages: ['m1'] }
    const out = await handlers.get('agent/pre-step')({ agent: { session: { id: 's-i' } }, messages: [], step: 1 }, () => decision)
    assert.equal(out, decision)
  })

  await check('缺少 systemPrompt 时不抛错', () => {
    const { ctx } = makeCtx()
    ctx.systemPrompt = undefined
    apply(ctx, { enabled: true, rules: [RULE] })
  })

  await check('缺少 ctx.on 时不抛错', () => {
    const { ctx } = makeCtx()
    ctx.on = undefined
    apply(ctx, { enabled: true, rules: [RULE] })
  })

  await check('pre-step 处理器异常被吞掉且仍返回决策', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    // 故意给一个会抛错的 agent（访问 session 时抛）
    const badAgent = { get session () { throw new Error('boom') } }
    const decision = { kind: 'proceed' }
    const out = await handlers.get('agent/pre-step')({ agent: badAgent, messages: [], step: 1 }, () => decision)
    assert.equal(out, decision)
  })

  await check('无条件规则：没有任何状态时也注入', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-always', name: '常驻', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [],
        action: { text: '始终生效的一条规则', once: false, cooldownTurns: 0 },
      }],
    })
    // 不触发任何事件，直接求值
    const text = registered.injectContext.text(assemble('s-always'))
    assert.ok(text.includes('始终生效的一条规则'), text)
  })

  await check('无条件 + once：第二次求值仍恒定，步边界后静默', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-always-once', name: '常驻一次', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [],
        action: { text: '只出现一次', once: true, cooldownTurns: 0 },
      }],
    })
    const session = { id: 's-ao', cwd: '' }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    const first = registered.injectContext.text(assemble('s-ao'))
    assert.equal(registered.injectContext.text(assemble('s-ao')), first, '同一步内必须恒定')
    // 同回合的后续步仍命中；下一个回合才静默
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 2 }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-ao')).includes('只出现一次'))
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-ao')), '')
  })

  // ── 第 2 轮补：回合号双来源不能重复计数 ──
  await check('turn/start 与 pre-step 同时出现时回合号不翻倍', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-turn', name: 'turn 探针', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [{ type: 'turn', op: 'gte', value: 1 }],
        action: { text: 'turn={{turn}}', once: false, cooldownTurns: 0 },
      }],
    })
    const { peekState } = await import('../src/session-state.js')
    const session = { id: 's-turn', cwd: '' }
    // 真实顺序：turn/start(turn=1) → pre-step(step=1)
    handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 1 } })
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(peekState('s-turn').turn, 1, '回合号被算了两次')
    // 第二回合
    handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 2 } })
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(peekState('s-turn').turn, 2)
  })

  await check('没有 turn/start 时用 step===1 兜底递增', async () => {
    resetStates()
    const { ctx, handlers } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    const { peekState } = await import('../src/session-state.js')
    const session = { id: 's-fb', cwd: '' }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(peekState('s-fb').turn, 1)
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 2 }, () => ({}))
    assert.equal(peekState('s-fb').turn, 1, '同一回合内的后续步不应再加')
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(peekState('s-fb').turn, 2)
  })

  await check('cooldown 以命中当时的回合号为准', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-cd', name: '冷却', enabled: true, scope: { type: 'global' }, match: 'all',
        conditions: [],
        action: { text: '跑一次', once: false, cooldownTurns: 2 },
      }],
    })
    const { peekState } = await import('../src/session-state.js')
    const session = { id: 's-cd', cwd: '' }
    // 第 1 回合命中
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-cd')).includes('跑一次'))
    // 第 2 回合开始：上一步的命中被提交，lastTurn 应记为命中的回合 1，而不是当前回合 2
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    assert.equal(peekState('s-cd').injected.get('r-cd').lastTurn, 1)
  })

  // ── 第 3 轮补：工作目录取自 session.header ──
  await check('project 作用域从 session.header.cwd 取目录', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-proj', name: '项目内', enabled: true, scope: { type: 'project', value: 'myDSH' }, match: 'all',
        conditions: [],
        action: { text: '项目内规则', once: false, cooldownTurns: 0 },
      }],
    })
    const inProject = { id: 's-proj', header: { cwd: 'D:\\0_code_codes\\myDSH' } }
    await handlers.get('agent/pre-step')({ agent: { session: inProject }, messages: [], step: 1 }, () => ({}))
    assert.ok(registered.injectContext.text(assemble('s-proj')).includes('项目内规则'))

    const elsewhere = { id: 's-other', header: { cwd: 'D:\\other\\repo' } }
    await handlers.get('agent/pre-step')({ agent: { session: elsewhere }, messages: [], step: 1 }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-other')), '')
  })

  await check('没有 header 时 project 作用域不命中且不抛错', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, {
      enabled: true,
      rules: [{
        id: 'r-proj2', name: '项目内', enabled: true, scope: { type: 'project', value: 'myDSH' }, match: 'all',
        conditions: [],
        action: { text: '项目内规则', once: false, cooldownTurns: 0 },
      }],
    })
    await handlers.get('agent/pre-step')({ agent: { session: { id: 's-nohdr' } }, messages: [], step: 1 }, () => ({}))
    assert.equal(registered.injectContext.text(assemble('s-nohdr')), '')
  })

  // ── 注入来源标识：标签 + 系统提示词约定 ──
  await check('注入内容包在带规则名的 conditional-inject 标签里', async () => {
    resetStates()
    const { ctx, handlers, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [RULE] })
    const session = { id: 's-tag', header: { cwd: '' } }
    await handlers.get('agent/pre-step')({ agent: { session }, messages: [], step: 1 }, () => ({}))
    handlers.get('session/event')(session, { type: 'request/context', data: { contextWindow: 1000 } })
    handlers.get('session/event')(session, { type: 'assistant/message', data: { usage: { inputTokens: 900 } } })
    const text = registered.injectContext.text(assemble('s-tag'))
    assert.ok(text.includes('<conditional-inject rule="部署提醒">'), text)
    assert.ok(text.trimEnd().endsWith('</conditional-inject>'))
  })

  await check('注册了约定段（走 context，绕开 complete section 裁剪），有规则时给出说明', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [RULE] })
    assert.ok(registered.noticeContext, '未注册约定段')
    assert.equal(registered.noticeContext.name, 'conditional-inject-notice')
    // 顺序必须早于注入段，模型先看到「这是什么」再看内容
    assert.ok(registered.noticeContext.order < registered.injectContext.order, '约定段应排在注入段之前')
    const text = registered.noticeContext.text()
    assert.ok(text.includes('<conditional-inject'), text)
    assert.ok(text.includes('不是用户'), text)
  })

  await check('没有规则时约定段返回空串（不给不用的人加噪音）', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [] })
    assert.equal(registered.noticeContext.text(), '')
  })

  await check('总开关关闭时约定段也返回空串', () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: false, rules: [RULE] })
    assert.equal(registered.noticeContext.text(), '')
  })

  await check('命中后写入「最近注入」记录，同一步重复求值只累加命中数', () => {    resetStates()
    clearTrace()
    const { ctx, registered } = makeCtx()
    // 用无条件规则：context 类条件在测试环境没有占用数据，不会命中
    const always = {
      id: 'r-trace',
      name: '常驻',
      enabled: true,
      scope: { type: 'global' },
      match: 'all',
      conditions: [],
      action: { text: '常驻内容', once: false, cooldownTurns: 0 },
    }
    apply(ctx, { enabled: true, rules: [always] })
    const text = registered.injectContext.text(assemble('s-trace'))
    const entries = listTrace()
    assert.equal(entries.length, 1, '应记录一条')
    assert.equal(entries[0].sessionId, 's-trace')
    assert.deepEqual(entries[0].rules, ['常驻'])
    assert.equal(entries[0].text, text, '记录的应就是注入原文')
    // 同一步再求值一次：不新增条目，只累加
    registered.injectContext.text(assemble('s-trace'))
    assert.equal(listTrace().length, 1)
    assert.equal(listTrace()[0].hits, 2)
  })

  await check('多会话命中：按会话分组、聚合统计、当前会话按最近活动', async () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    const always = {
      id: 'r-multi', name: '常驻', enabled: true, scope: { type: 'global' }, match: 'all',
      conditions: [], action: { text: '内容', once: false, cooldownTurns: 0 },
    }
    apply(ctx, { enabled: true, rules: [always] })
    registered.injectContext.text(assemble('s-a'))
    await new Promise((resolve) => setTimeout(resolve, 3))
    registered.injectContext.text(assemble('s-b'))

    const bySession = hitCountsBySession()
    assert.deepEqual(Object.keys(bySession).sort(), ['s-a', 's-b'])
    assert.equal(bySession['s-a']['r-multi'], 1)
    assert.equal(bySession['s-b']['r-multi'], 1)

    const stats = hitStats()['r-multi']
    assert.equal(stats.total, 2, '跨会话累计')
    assert.equal(stats.sessions, 2, '涉及 2 个会话')
    assert.ok(stats.lastAt > 0, '应有最近命中时间')

    assert.equal(lastActiveSessionId(), 's-b', '当前会话应按最近活动取，而不是插入顺序')
  })

  await check('/state 带当前会话、分组命中与聚合统计', async () => {
    resetStates()
    const { ctx, registered } = makeCtx()
    apply(ctx, { enabled: true, rules: [RULE] })
    const stateRoute = registered.routes.find((route) => route.path.endsWith('/state'))
    assert.ok(stateRoute, '未注册 /state')
    const out = { status: null, body: '' }
    const res = { headersSent: false, writeHead (s) { out.status = s; this.headersSent = true }, end (c) { if (c) out.body += c } }
    await stateRoute.handler({ method: 'GET' }, res)
    assert.equal(out.status, 200)
    const body = JSON.parse(out.body)
    assert.ok(Array.isArray(body.trace), 'state 应带 trace')
    assert.ok(typeof body.currentSessionId === 'string', 'state 应带 currentSessionId')
    assert.ok(body.hitsBySession && typeof body.hitsBySession === 'object', 'state 应带 hitsBySession')
    assert.ok(body.hitStats && typeof body.hitStats === 'object', 'state 应带 hitStats')
  })

  console.log(`\n${passed} 项集成断言通过`)
}

run()
