// 路由契约测试：mock req/res 直接打三条路由，不经过 HTTP。
// 覆盖 405 / 400 / 413 / 白名单过滤 / preview 命中与不命中。
import assert from 'node:assert/strict'

import { createRoutes } from '../src/routes.js'

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

/** 造一个可读的请求体流。 */
function req (method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    async *[Symbol.asyncIterator] () {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 记录响应。 */
function res () {
  const out = { status: null, headers: null, body: '' }
  return {
    out,
    headersSent: false,
    writeHead (status, headers) { out.status = status; out.headers = headers || {}; this.headersSent = true },
    end (chunk) { if (chunk !== undefined) out.body += chunk },
  }
}

const RULE = {
  id: 'r1', name: '部署', enabled: true, scope: { type: 'global' }, match: 'all',
  conditions: [{ type: 'context', op: 'gte', value: 80 }],
  action: { text: '占用 {{percent}}%', once: false, cooldownTurns: 0 },
}

function harness (settings) {
  let current = settings || { enabled: true, rules: [RULE] }
  const saved = []
  const routes = createRoutes({
    getSettings: () => current,
    setSettings: (next) => { current = next },
    persist: (next) => { saved.push(next); return true },
    sessionSummary: () => ({ sessions: [{ sessionId: 's1', turn: 2, percent: 81 }], hits: { r1: 3 } }),
    log: { info: () => {}, warn: () => {} },
  })
  const byPath = new Map(routes.map((r) => [r.path, r]))
  return { routes, byPath, saved, settings: () => current }
}

const find = (byPath, suffix) => [...byPath.entries()].find(([path]) => path.endsWith(suffix))[1]

async function run () {
  await check('声明了三条路由且 path 带前缀', () => {
    const { routes } = harness()
    assert.equal(routes.length, 3)
    for (const route of routes) {
      assert.ok(route.path.startsWith('/api/dsh-conditional-rules/'), route.path)
      assert.equal(route.kind, 'exact')
      assert.equal(typeof route.handler, 'function')
    }
  })

  await check('GET /state 返回版本、设置与会话摘要', async () => {
    const { byPath } = harness()
    const r = res()
    await find(byPath, '/state').handler(req('GET'), r)
    assert.equal(r.out.status, 200)
    assert.equal(r.out.headers['cache-control'], 'no-store')
    const body = JSON.parse(r.out.body)
    assert.ok(body.version)
    assert.equal(body.settings.rules.length, 1)
    assert.equal(body.sessions[0].sessionId, 's1')
    assert.equal(body.hits.r1, 3)
  })

  await check('HEAD /state 同样放行，POST /state 返回 405', async () => {
    const { byPath } = harness()
    const ok = res()
    await find(byPath, '/state').handler(req('HEAD'), ok)
    assert.equal(ok.out.status, 200)
    const bad = res()
    await find(byPath, '/state').handler(req('POST', '{}'), bad)
    assert.equal(bad.out.status, 405)
  })

  await check('POST /set 保存合法改动并落盘', async () => {
    const h = harness()
    const r = res()
    await find(h.byPath, '/set').handler(req('POST', JSON.stringify({ enabled: false })), r)
    assert.equal(r.out.status, 200)
    const body = JSON.parse(r.out.body)
    assert.equal(body.ok, true)
    assert.equal(body.changed, true)
    assert.equal(h.settings().enabled, false)
    assert.equal(h.saved.length, 1)
  })

  await check('POST /set 未知字段被丢弃', async () => {
    const h = harness()
    const r = res()
    await find(h.byPath, '/set').handler(req('POST', JSON.stringify({ evil: 1, rules: [{ conditions: [], action: { text: 'x' }, evil: 2 }] })), r)
    const body = JSON.parse(r.out.body)
    assert.equal(body.ok, true)
    assert.equal(h.settings().rules.length, 1)
    assert.equal(h.settings().rules[0].evil, undefined)
  })

  await check('POST /set 非法 JSON 返回 400 且不改设置', async () => {
    const h = harness()
    const r = res()
    await find(h.byPath, '/set').handler(req('POST', '{oops'), r)
    assert.equal(r.out.status, 400)
    assert.equal(JSON.parse(r.out.body).ok, false)
    assert.equal(h.saved.length, 0)
  })

  await check('POST /set 超大请求体返回 413', async () => {
    const h = harness()
    const r = res()
    const huge = 'x'.repeat(300 * 1024)
    await find(h.byPath, '/set').handler(req('POST', JSON.stringify({ rules: [], pad: huge })), r)
    assert.equal(r.out.status, 413)
    assert.equal(h.saved.length, 0)
  })

  await check('POST /preview 命中并渲染变量', async () => {
    const { byPath } = harness()
    const r = res()
    await find(byPath, '/preview').handler(req('POST', JSON.stringify({ percent: 85, turn: 1 })), r)
    const body = JSON.parse(r.out.body)
    assert.equal(body.ok, true)
    assert.deepEqual(body.matched, ['r1'])
    assert.ok(body.text.includes('85'), body.text)
  })

  await check('POST /preview 未命中返回空文本', async () => {
    const { byPath } = harness()
    const r = res()
    await find(byPath, '/preview').handler(req('POST', JSON.stringify({ percent: 10, turn: 1 })), r)
    const body = JSON.parse(r.out.body)
    assert.deepEqual(body.matched, [])
    assert.equal(body.text, '')
  })

  await check('POST /preview 可直接用草稿规则（不落盘）', async () => {
    const h = harness()
    const r = res()
    const draft = [{ id: 'draft', name: 'd', enabled: true, scope: { type: 'global' }, match: 'all', conditions: [], action: { text: '草稿规则', once: false, cooldownTurns: 0 } }]
    await find(h.byPath, '/preview').handler(req('POST', JSON.stringify({ rules: draft })), r)
    const body = JSON.parse(r.out.body)
    assert.deepEqual(body.matched, ['draft'])
    assert.equal(h.saved.length, 0, 'preview 不应落盘')
  })

  await check('POST /set 落盘失败返回 500 且设置不变', async () => {
    let current = { enabled: true, rules: [] }
    const routes = createRoutes({
      getSettings: () => current,
      setSettings: (next) => { current = next },
      persist: () => false,
      sessionSummary: () => ({ sessions: [] }),
      log: { info: () => {}, warn: () => {} },
    })
    const route = [...routes].find((r) => r.path.endsWith('/set'))
    const r = res()
    await route.handler(req('POST', JSON.stringify({ enabled: false })), r)
    assert.equal(r.out.status, 500)
    assert.equal(current.enabled, true, '写失败后内存设置不能被改')
  })

  await check('GET /preview 返回 405', async () => {
    const { byPath } = harness()
    const r = res()
    await find(byPath, '/preview').handler(req('GET'), r)
    assert.equal(r.out.status, 405)
  })

  console.log(`\n${passed} 项路由断言通过`)
}

run()
