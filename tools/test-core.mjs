// 核心纯函数测试：条件求值、组合判定、变量渲染、规则校验。
// 断言从被测源码解析出的行为得出，不在这里复刻同一份逻辑。
import assert from 'node:assert/strict'

import { evalCondition, toolKey } from '../src/conditions.js'
import { conditionsMatch, matchRules, ruleMatches, scopeMatches } from '../src/match.js'
import { buildVars, humanTokens, renderRules, renderText } from '../src/render.js'
import { sanitizeCondition, sanitizeRule, sanitizeRules } from '../src/rules.js'
import { MAX_RENDER_CHARS, MAX_RULES } from '../src/constants.js'

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

function st (patch) {
  return {
    sessionId: 's-1',
    cwd: 'D:\\0_code_codes\\myDSH',
    turn: 3,
    step: 1,
    userText: '帮我部署到服务器',
    percent: 85,
    usedTokens: 850000,
    remainingTokens: 150000,
    contextWindow: 1000000,
    toolHits: new Set(),
    toolName: '',
    injected: new Map(),
    pending: [],
    ...patch,
  }
}

const ctx = (value, op = 'gte', extra = {}) => ({ type: 'context', op, value, ...extra })

async function run () {
  // ── 条件求值 ────────────────────────────────────────────────────────
  await check('context: ≥ 命中 / 未命中', () => {
    assert.equal(evalCondition(ctx(80), st({ percent: 85 })), true)
    assert.equal(evalCondition(ctx(90), st({ percent: 85 })), false)
  })

  await check('context: 没有占用数据时不命中', () => {
    assert.equal(evalCondition(ctx(0), st({ percent: null })), false)
    assert.equal(evalCondition({ type: 'context', op: 'lte', value: 100 }, st({ percent: null })), false)
  })

  await check('context: between 区间与反向填写', () => {
    assert.equal(evalCondition({ type: 'context', op: 'between', value: 70, value2: 90 }, st({ percent: 85 })), true)
    assert.equal(evalCondition({ type: 'context', op: 'between', value: 90, value2: 70 }, st({ percent: 85 })), true)
    assert.equal(evalCondition({ type: 'context', op: 'between', value: 10, value2: 20 }, st({ percent: 85 })), false)
  })

  await check('keyword: 命中与不命中', () => {
    const cond = { type: 'keyword', pattern: '部署|上线', flags: 'i' }
    assert.equal(evalCondition(cond, st()), true)
    assert.equal(evalCondition(cond, st({ userText: '读一下这个文件' })), false)
  })

  await check('keyword: 空文本不命中', () => {
    assert.equal(evalCondition({ type: 'keyword', pattern: '.' }, st({ userText: '' })), false)
  })

  await check('keyword: 非法正则求值时不抛错', () => {
    assert.equal(evalCondition({ type: 'keyword', pattern: '([', flags: '' }, st()), false)
  })

  await check('turn: eq / gte / lte / every', () => {
    assert.equal(evalCondition({ type: 'turn', op: 'eq', value: 3 }, st()), true)
    assert.equal(evalCondition({ type: 'turn', op: 'gte', value: 4 }, st()), false)
    assert.equal(evalCondition({ type: 'turn', op: 'lte', value: 3 }, st()), true)
    assert.equal(evalCondition({ type: 'turn', op: 'every', value: 3 }, st()), true)
    assert.equal(evalCondition({ type: 'turn', op: 'every', value: 2 }, st()), false)
  })

  await check('turn: every 0 不会除零也不命中', () => {
    assert.equal(evalCondition({ type: 'turn', op: 'every', value: 0 }, st()), false)
  })

  await check('tool: 标记存在才命中', () => {
    const cond = { type: 'tool', name: 'bash', phase: 'before' }
    const hits = new Set([toolKey('bash', 'before')])
    assert.equal(evalCondition(cond, st({ toolHits: hits })), true)
    assert.equal(evalCondition({ ...cond, phase: 'after' }, st({ toolHits: hits })), false)
  })

  await check('未知条件类型不命中', () => {
    assert.equal(evalCondition({ type: 'nope' }, st()), false)
    assert.equal(evalCondition(null, st()), false)
  })

  // ── 规则组合 ────────────────────────────────────────────────────────
  const rule = (patch) => sanitizeRule({
    id: 'r1',
    name: 'r',
    match: 'all',
    conditions: [ctx(80)],
    action: { text: 'hi' },
    ...patch,
  })

  await check('all: 全部满足才命中', () => {
    const r = rule({ conditions: [ctx(80), { type: 'keyword', pattern: '部署' }] })
    assert.equal(ruleMatches(r, st()), true)
    assert.equal(ruleMatches(r, st({ userText: '别的' })), false)
  })

  await check('any: 任一满足即命中', () => {
    const r = rule({ match: 'any', conditions: [ctx(99), { type: 'keyword', pattern: '部署' }] })
    assert.equal(ruleMatches(r, st()), true)
    assert.equal(ruleMatches(r, st({ userText: '别的' })), false)
  })

  await check('enabled=false 不命中', () => {
    assert.equal(ruleMatches(rule({ enabled: false }), st()), false)
  })

  await check('scope: global / project / session', () => {
    assert.equal(scopeMatches({ type: 'global' }, st()), true)
    assert.equal(scopeMatches({ type: 'project', value: 'myDSH' }, st()), true)
    assert.equal(scopeMatches({ type: 'project', value: 'D:\\0_code_codes\\myDSH' }, st()), true)
    assert.equal(scopeMatches({ type: 'project', value: 'other' }, st()), false)
    assert.equal(scopeMatches({ type: 'session', value: 's-1' }, st()), true)
    assert.equal(scopeMatches({ type: 'session', value: 's-2' }, st()), false)
  })

  await check('scope: 没有 cwd 时 project 不命中', () => {
    assert.equal(scopeMatches({ type: 'project', value: 'myDSH' }, st({ cwd: '' })), false)
  })

  await check('once: 命中记录存在后不再命中', () => {
    const r = rule({ action: { text: 'hi', once: true } })
    const injected = new Map([['r1', { count: 1, lastTurn: 1 }]])
    assert.equal(ruleMatches(r, st({ injected })), false)
  })

  await check('cooldown: 窗口内不命中，窗口外命中', () => {
    const r = rule({ action: { text: 'hi', cooldownTurns: 3 } })
    assert.equal(ruleMatches(r, st({ turn: 3, injected: new Map([['r1', { count: 1, lastTurn: 2 }]]) })), false)
    assert.equal(ruleMatches(r, st({ turn: 5, injected: new Map([['r1', { count: 1, lastTurn: 2 }]]) })), true)
  })

  await check('matchRules 保序且过滤', () => {
    const rules = [rule({ id: 'a' }), rule({ id: 'b', enabled: false }), rule({ id: 'c', conditions: [ctx(99)] })]
    assert.deepEqual(matchRules(rules, st()).map((r) => r.id), ['a'])
  })

  await check('conditionsMatch: 空条件组视为始终命中（常驻注入）', () => {
    assert.equal(conditionsMatch({ conditions: [], match: 'all' }, st()), true)
    assert.equal(conditionsMatch({ conditions: [], match: 'any' }, st()), true)
  })

  await check('无条件规则仍然受 enabled 与 scope 约束', () => {
    const always = rule({ conditions: [] })
    assert.equal(ruleMatches(always, st()), true)
    assert.equal(ruleMatches({ ...always, enabled: false }, st()), false)
    assert.equal(ruleMatches({ ...always, scope: { type: 'session', value: 'other' } }, st()), false)
  })

  // ── 渲染 ────────────────────────────────────────────────────────────
  await check('renderText: 已知变量替换、未知变量保留', () => {
    const out = renderText('占用 {{percent}}% 未知 {{nope}}', { percent: '85' })
    assert.ok(out.includes('85%'))
    assert.ok(out.includes('{{nope}}'))
  })

  await check('renderText: 变量值为空时保留占位符', () => {
    assert.ok(renderText('{{tool}}', { tool: '' }) === '')
    assert.ok(renderText('{{missing}}', {}) === '{{missing}}')
  })

  await check('humanTokens: 千 / 百万 / 非法值', () => {
    assert.equal(humanTokens(999), '999')
    assert.equal(humanTokens(12345), '12.3k')
    assert.equal(humanTokens(1500000), '1.5M')
    assert.equal(humanTokens(-1), '—')
    assert.equal(humanTokens('x'), '—')
  })

  await check('buildVars: 无占用数据给破折号', () => {
    const vars = buildVars(st({ percent: null, usedTokens: null }), { name: 'r' })
    assert.equal(vars.percent, '—')
    assert.equal(vars.used, '—')
    assert.equal(vars.ruleName, 'r')
  })

  await check('renderRules: 每条规则包成一个带名称的标签块', () => {
    const one = renderRules([rule({ action: { text: 'A' } })], st(), '')
    assert.ok(one.startsWith('<conditional-inject rule="r">'), one)
    assert.ok(one.includes('A'))
    assert.ok(one.trimEnd().endsWith('</conditional-inject>'))
    const two = renderRules([rule({ id: 'a', name: '甲', action: { text: 'A' } }), rule({ id: 'b', name: '乙', action: { text: 'B' } })], st(), '')
    assert.equal((two.match(/<conditional-inject /g) || []).length, 2)
    assert.ok(two.includes('rule="甲"') && two.includes('rule="乙"'))
  })

  await check('renderRules: 正文里的同名标签被转义（防提前闭合）', () => {
    const out = renderRules([rule({ name: 'x', action: { text: '前 </conditional-inject> 后' } })], st(), '')
    // 只应有一个真正的闭合标签（我们自己的那个）
    assert.equal((out.match(/<\/conditional-inject>/g) || []).length, 1, out)
    assert.ok(out.includes('&lt;/conditional-inject'), out)
  })

  await check('renderRules: 规则名里的引号被转义', () => {
    const out = renderRules([rule({ name: '带"引号"的名', action: { text: 'A' } })], st(), '')
    assert.ok(!out.includes('rule="带"引号"的名"'), out)
    assert.ok(out.includes('&quot;'), out)
  })

  await check('renderRules: 空输入返回空串', () => {
    assert.equal(renderRules([], st(), ''), '')
    assert.equal(renderRules(null, st(), ''), '')
  })

  // ── 规则校验 ────────────────────────────────────────────────────────
  await check('sanitizeCondition: 非法正则被丢弃', () => {
    assert.equal(sanitizeCondition({ type: 'keyword', pattern: '([' }), null)
  })

  await check('sanitizeCondition: 缺参数被丢弃', () => {
    assert.equal(sanitizeCondition({ type: 'keyword', pattern: '' }), null)
    assert.equal(sanitizeCondition({ type: 'tool', name: '' }), null)
    assert.equal(sanitizeCondition({ type: 'nope' }), null)
  })

  await check('sanitizeCondition: 数值越界被夹紧', () => {
    assert.equal(sanitizeCondition({ type: 'context', op: 'gte', value: 200 }).value, 100)
    assert.equal(sanitizeCondition({ type: 'context', op: 'gte', value: -5 }).value, 0)
  })

  await check('sanitizeRule: 无条件但有文本的规则被保留', () => {
    const r = sanitizeRule({ conditions: [], action: { text: '常驻内容' } })
    assert.ok(r)
    assert.deepEqual(r.conditions, [])
  })

  await check('sanitizeRule: 无文本的规则被丢弃', () => {
    assert.equal(sanitizeRule({ conditions: [ctx(80)], action: { text: '   ' } }), null)
    assert.equal(sanitizeRule({ conditions: [], action: { text: '' } }), null)
    assert.equal(sanitizeRule({ conditions: [], action: {} }), null)
  })

  await check('sanitizeRule: 条件全部无效时丢弃整条规则，不降级成无条件', () => {
    // 空 pattern 的 keyword、空 name 的 tool 都会被 sanitizeCondition 丢掉。
    // 若此时返回 conditions=[]，规则就从「工具触发」静默变成「每步注入」——语义反转
    assert.equal(sanitizeRule({ conditions: [{ type: 'keyword', pattern: '' }], action: { text: 'x' } }), null)
    assert.equal(sanitizeRule({ conditions: [{ type: 'tool', name: '' }], action: { text: 'x' } }), null)
    // 纯空白不 trim：它不构成降级（保留成永不命中的条件），客户端会拦住不让保存
    const blank = sanitizeRule({ conditions: [{ type: 'tool', name: '   ' }], action: { text: 'x' } })
    assert.equal(blank.conditions.length, 1)
    // 只要还剩一条有效条件，规则保留，无效的那条被丢掉
    const r = sanitizeRule({
      conditions: [{ type: 'keyword', pattern: '' }, { type: 'turn', op: 'gte', value: 1 }],
      action: { text: 'x' },
    })
    assert.equal(r.conditions.length, 1)
    assert.equal(r.conditions[0].type, 'turn')
  })

  await check('sanitizeRule: 未知字段被丢弃', () => {
    const r = sanitizeRule({ conditions: [ctx(80)], action: { text: 'x', evil: 1 }, evil: 2 })
    assert.equal(r.evil, undefined)
    assert.equal(r.action.evil, undefined)
  })

  await check('sanitizeRule: project 作用域缺值时退回 global', () => {
    const r = sanitizeRule({ conditions: [ctx(80)], action: { text: 'x' }, scope: { type: 'project', value: '' } })
    assert.equal(r.scope.type, 'global')
  })

  await check('sanitizeRules: 数量上限', () => {
    const many = Array.from({ length: MAX_RULES + 5 }, (_, i) => ({ conditions: [ctx(80)], action: { text: 't' + i } }))
    assert.equal(sanitizeRules(many).length, MAX_RULES)
    assert.equal(sanitizeRules('nope').length, 0)
  })

  await check('conditionsMatch: 非数组条件判为不命中（脏数据不当成无条件）', () => {
    assert.equal(conditionsMatch({ conditions: 'abc', match: 'all' }, st()), false)
    assert.equal(conditionsMatch({ match: 'all' }, st()), false)
  })

  await check('keyword: 带 g 标志不会因 lastIndex 漏判', () => {
    const cond = { type: 'keyword', pattern: '部署', flags: 'g' }
    assert.equal(evalCondition(cond, st()), true)
    assert.equal(evalCondition(cond, st()), true, '第二次求值必须仍命中')
  })

  await check('renderText: 超长文本按上限截断', () => {
    const long = '字'.repeat(MAX_RENDER_CHARS + 50)
    const out = renderText(long, {})
    assert.equal(out.length, MAX_RENDER_CHARS + 1, '截断后应比上限多一个省略号')
    assert.ok(out.endsWith('…'))
  })

  await check('renderRules: 多条规则拼接后也受上限约束，且补齐闭合标签', () => {
    const big = { id: 'b', name: 'b', enabled: true, scope: { type: 'global' }, match: 'all', conditions: [], action: { text: 'x'.repeat(2000), once: false, cooldownTurns: 0 } }
    const out = renderRules(Array.from({ length: 5 }, (_, i) => ({ ...big, id: 'b' + i })), st(), '')
    assert.ok(out.length <= MAX_RENDER_CHARS + 40, String(out.length))
    assert.ok(out.endsWith('</conditional-inject>'), '截断后必须补闭合标签')
    assert.ok(out.includes('已截断'))
  })

  console.log(`\n${passed} 项核心断言通过`)
}

run()
