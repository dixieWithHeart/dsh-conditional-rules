// 工具契约测试：schema 形状、五个 action 的行为、异常分支。
// 宿主的硬要求（缺一样就静默注册失败）在这里逐条断言。
import assert from 'node:assert/strict'

import { createToolDefinition } from '../src/tool.js'
import { MAX_RULES } from '../src/constants.js'

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

function harness (rules = []) {
  let current = { enabled: true, rules }
  const saved = []
  const tool = createToolDefinition({
    getSettings: () => current,
    setSettings: (next) => { current = next },
    persist: (next) => { saved.push(next); return true },
    log: { info: () => {}, warn: () => {} },
  })
  return { tool, saved, settings: () => current }
}

// 工具默认作用域依赖 execute 的第二参数（宿主传入的 exec，含 agent）
const RUN = { agent: { session: { id: 'sess-current', header: { cwd: 'D:\\\\0_code_codes\\\\myDSH' } } } }

const CONTEXT_RULE = {
  name: '占用提醒',
  conditions: [{ type: 'context', op: 'gte', value: 80 }],
  action: { text: '占用 {{percent}}% 了' },
}

async function run () {
  // ── 宿主硬契约 ────────────────────────────────────────────────────
  await check('工具名、描述与 output.render 齐备', () => {
    const { tool } = harness()
    assert.equal(tool.name, 'cond_inject')
    assert.ok(tool.description.length > 50)
    assert.ok(tool.output && typeof tool.output.render === 'function')
    assert.equal(typeof tool.execute, 'function')
  })

  await check('parameters 是原生 JSON Schema', () => {
    const { tool } = harness()
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(Array.isArray(tool.parameters.required) && tool.parameters.required.includes('action'))
    assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'get', 'create', 'update', 'delete', 'preview'])
  })

  await check('output.schema 显式声明 additionalProperties', () => {
    const { tool } = harness()
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, true)
  })

  await check('output.render 返回 content 数组', () => {
    const { tool } = harness()
    const content = tool.output.render({}, { ok: true })
    assert.ok(Array.isArray(content))
    assert.equal(content[0].type, 'text')
    assert.ok(content[0].text.includes('"ok": true'))
  })

  // ── list ─────────────────────────────────────────────────────────
  await check('list 只返回摘要，不吐全量正文', async () => {
    const long = '字'.repeat(1500)
    const { tool } = harness([{ ...CONTEXT_RULE, id: 'r1', name: '占用提醒', enabled: true, scope: { type: 'global' }, match: 'all', action: { text: long, once: false, cooldownTurns: 0 } }])
    const out = await tool.execute({ action: 'list' })
    assert.equal(out.ok, true)
    assert.equal(out.count, 1)
    assert.equal(out.rules[0].id, 'r1')
    assert.equal(out.rules[0].textPreview.length, 80)
    assert.equal(out.rules[0].textLength, 1500)
    // 摘要整条序列化后必须远小于正文（1500 字），否则等于没做摘要
    assert.ok(JSON.stringify(out.rules[0]).length < 500, 'list 摘要里混进了正文')
  })

  await check('get 按 id 返回完整规则', async () => {
    const { tool } = harness([{ ...CONTEXT_RULE, id: 'r1', name: '占用提醒', enabled: true, scope: { type: 'global' }, match: 'all' }])
    const out = await tool.execute({ action: 'get', id: 'r1' })
    assert.equal(out.ok, true)
    assert.equal(out.rule.action.text, CONTEXT_RULE.action.text)
    assert.equal((await tool.execute({ action: 'get', id: 'nope' })).ok, false)
    assert.equal((await tool.execute({ action: 'get' })).ok, false)
  })

  // ── create ───────────────────────────────────────────────────────
  await check('create 新增规则并落盘', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: CONTEXT_RULE }, RUN)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.ok(out.rule.id, '应自动生成 id')
    assert.equal(h.settings().rules.length, 1)
    assert.equal(h.saved.length, 1)
  })

  await check('create 无条件规则（常驻注入）', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: { name: '常驻', conditions: [], action: { text: '始终注入' } } }, RUN)
    assert.equal(out.ok, true)
    assert.deepEqual(h.settings().rules[0].conditions, [])
  })

  await check('create 缺文本被拒绝', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: { name: 'x', conditions: [] } }, RUN)
    assert.equal(out.ok, false)
    assert.ok(out.error.includes('无效'))
    assert.equal(h.settings().rules.length, 0)
  })

  await check('create 的 id 撞车时重新生成', async () => {
    const h = harness([{ ...CONTEXT_RULE, id: 'dup', name: '旧', enabled: true, scope: { type: 'global' }, match: 'all' }])
    const out = await h.tool.execute({ action: 'create', rule: { ...CONTEXT_RULE, id: 'dup' } }, RUN)
    assert.equal(out.ok, true)
    const ids = h.settings().rules.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
  })

  await check('create 达到上限时拒绝', async () => {
    const many = Array.from({ length: MAX_RULES }, (_, i) => ({
      ...CONTEXT_RULE, id: 'r' + i, name: 'r' + i, enabled: true, scope: { type: 'global' }, match: 'all',
    }))
    const h = harness(many)
    const out = await h.tool.execute({ action: 'create', rule: CONTEXT_RULE }, RUN)
    assert.equal(out.ok, false)
    assert.ok(out.error.includes(String(MAX_RULES)))
  })

  // ── update ───────────────────────────────────────────────────────
  await check('update 按 id 覆盖且保留 id', async () => {
    const h = harness([{ ...CONTEXT_RULE, id: 'keep', name: '旧名', enabled: true, scope: { type: 'global' }, match: 'all' }])
    const out = await h.tool.execute({ action: 'update', rule: { id: 'keep', name: '新名', conditions: [], action: { text: '新文本' } } }, RUN)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(h.settings().rules[0].id, 'keep')
    assert.equal(h.settings().rules[0].name, '新名')
  })

  await check('update 缺 id 或 id 不存在时报错', async () => {
    const h = harness([{ ...CONTEXT_RULE, id: 'a', name: 'a', enabled: true, scope: { type: 'global' }, match: 'all' }])
    assert.equal((await h.tool.execute({ action: 'update', rule: { name: 'x', conditions: [], action: { text: 'x' } } }, RUN)).ok, false)
    assert.equal((await h.tool.execute({ action: 'update', rule: { id: 'nope', name: 'x', conditions: [], action: { text: 'x' } } }, RUN)).ok, false)
  })

  // ── delete ───────────────────────────────────────────────────────
  await check('delete 按 id 删除', async () => {
    const h = harness([{ ...CONTEXT_RULE, id: 'gone', name: 'g', enabled: true, scope: { type: 'global' }, match: 'all' }])
    const out = await h.tool.execute({ action: 'delete', id: 'gone' }, RUN)
    assert.equal(out.ok, true)
    assert.equal(h.settings().rules.length, 0)
  })

  await check('delete 缺 id 或不存在时报错', async () => {
    const h = harness()
    assert.equal((await h.tool.execute({ action: 'delete' }, RUN)).ok, false)
    assert.equal((await h.tool.execute({ action: 'delete', id: 'nope' }, RUN)).ok, false)
  })

  // ── preview ──────────────────────────────────────────────────────
  await check('preview 命中并渲染变量', async () => {
    const h = harness([{ ...CONTEXT_RULE, id: 'p', name: 'p', enabled: true, scope: { type: 'global' }, match: 'all' }])
    const out = await h.tool.execute({ action: 'preview', preview: { percent: 90 } }, RUN)
    assert.equal(out.ok, true)
    assert.equal(out.matched.length, 1)
    assert.ok(out.text.includes('90'), out.text)
  })

  await check('preview 未命中给空文本', async () => {
    const h = harness([{ ...CONTEXT_RULE, id: 'p', name: 'p', enabled: true, scope: { type: 'global' }, match: 'all' }])
    const out = await h.tool.execute({ action: 'preview', preview: { percent: 10 } }, RUN)
    assert.deepEqual(out.matched, [])
    assert.equal(out.text, '')
  })

  await check('preview 可用草稿规则且不落盘', async () => {
    const h = harness()
    const out = await h.tool.execute({
      action: 'preview',
      rules: [{ name: '草稿', conditions: [], action: { text: '草稿内容' } }],
      preview: {},
    })
    assert.equal(out.matched.length, 1)
    assert.equal(h.saved.length, 0, 'preview 不应写盘')
  })

  await check('未知 action 报错', async () => {
    const h = harness()
    assert.equal((await h.tool.execute({ action: 'nope' }, RUN)).ok, false)
    assert.equal((await h.tool.execute({}, RUN)).ok, false)
  })

  await check('persist 失败时返回错误且不改内存设置', async () => {
    let current = { enabled: true, rules: [] }
    const tool = createToolDefinition({
      getSettings: () => current,
      setSettings: (next) => { current = next },
      persist: () => false,
      log: { info: () => {}, warn: () => {} },
    })
    const out = await tool.execute({ action: 'create', rule: CONTEXT_RULE }, RUN)
    assert.equal(out.ok, false)
    assert.ok(out.error.includes('写入失败'))
    assert.equal(current.rules.length, 0, '写失败后内存不能有这条规则')
  })

  await check('delete 落盘失败时规则仍在内存里', async () => {
    const existing = { ...CONTEXT_RULE, id: 'keep', name: 'k', enabled: true, scope: { type: 'global' }, match: 'all' }
    let current = { enabled: true, rules: [existing] }
    const tool = createToolDefinition({
      getSettings: () => current,
      setSettings: (next) => { current = next },
      persist: () => false,
      log: { info: () => {}, warn: () => {} },
    })
    const out = await tool.execute({ action: 'delete', id: 'keep' }, RUN)
    assert.equal(out.ok, false)
    assert.equal(current.rules.length, 1, '写失败后规则不能被内存删掉')
  })

  // ── 默认作用域：不传就是当前会话，绝不静默放大到全局 ──
  await check('create 不传 scope 时落到当前会话', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: CONTEXT_RULE }, RUN)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(h.settings().rules[0].scope, { type: 'session', value: 'sess-current' })
  })

  await check('create 显式 global 时尊重用户选择', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: { ...CONTEXT_RULE, scope: { type: 'global' } } }, RUN)
    assert.equal(out.ok, true)
    assert.deepEqual(h.settings().rules[0].scope, { type: 'global' })
  })

  await check('create 显式 project 时保留路径', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: { ...CONTEXT_RULE, scope: { type: 'project', value: 'myDSH' } } }, RUN)
    assert.equal(out.ok, true)
    assert.deepEqual(h.settings().rules[0].scope, { type: 'project', value: 'myDSH' })
  })

  await check('拿不到会话时拒绝创建而不是退到全局', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: CONTEXT_RULE })
    assert.equal(out.ok, false)
    assert.ok(out.error.includes('scope'), out.error)
    assert.equal(h.settings().rules.length, 0, '不能悄悄写进一条全局规则')
  })

  await check('没有会话 id 但有 cwd 时退到项目作用域', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: CONTEXT_RULE }, { agent: { session: { header: { cwd: 'D:\\p\\myDSH' } } } })
    assert.equal(out.ok, true)
    assert.deepEqual(h.settings().rules[0].scope, { type: 'project', value: 'D:\\p\\myDSH' })
  })

  await check('update 不传 scope 时沿用原作用域', async () => {
    const h = harness([{
      ...CONTEXT_RULE, id: 'keep', name: '旧', enabled: true, scope: { type: 'global' }, match: 'all',
    }])
    const out = await h.tool.execute({ action: 'update', rule: { id: 'keep', name: '新名', conditions: [{ type: 'turn', op: 'gte', value: 2 }], action: { text: '新文本' } } }, RUN)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(h.settings().rules[0].scope, { type: 'global' }, '不该被改成本会话')
  })

  await check('update 显式改 scope 时生效', async () => {
    const h = harness([{
      ...CONTEXT_RULE, id: 'keep', name: '旧', enabled: true, scope: { type: 'global' }, match: 'all',
    }])
    const out = await h.tool.execute({ action: 'update', rule: { id: 'keep', name: '旧', scope: { type: 'session', value: 'sess-current' }, conditions: [], action: { text: 'x' } } }, RUN)
    assert.equal(out.ok, true)
    assert.deepEqual(h.settings().rules[0].scope, { type: 'session', value: 'sess-current' })
  })

  await check('显式 project 但缺 value 时拒绝（不许静默放大成 global）', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: { ...CONTEXT_RULE, scope: { type: 'project' } } }, RUN)
    assert.equal(out.ok, false)
    assert.ok(out.error.includes('scope.value'), out.error)
    assert.equal(h.settings().rules.length, 0)
  })

  await check('显式 session 但缺 value 时拒绝', async () => {
    const h = harness()
    const out = await h.tool.execute({ action: 'create', rule: { ...CONTEXT_RULE, scope: { type: 'session', value: '   ' } } }, RUN)
    assert.equal(out.ok, false)
  })

  await check('schema 声明了 preview 用的 rules 草稿参数', () => {
    const { tool } = harness()
    const props = tool.parameters.properties
    assert.ok(props.rules, 'parameters 里必须有 rules，否则宿主按 additionalProperties:false 拒绝')
    assert.equal(props.rules.type, 'array')
    assert.ok(props.rules.items && props.rules.items.type === 'object')
    // 与单条 rule 用同一份结构
    assert.deepEqual(Object.keys(props.rules.items.properties).sort(), Object.keys(props.rule.properties).sort())
  })

  await check('create 生成的 id 不与现有重复', async () => {
    // 构造一个「按 Date.now 生成会撞车」的场景：先用同名规则占位，再连建两条
    const h = harness()
    await h.tool.execute({ action: 'create', rule: CONTEXT_RULE }, RUN)
    await h.tool.execute({ action: 'create', rule: CONTEXT_RULE }, RUN)
    const ids = h.settings().rules.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, ids.join(','))
  })

  console.log(`\n${passed} 项工具断言通过`)
}

run()
