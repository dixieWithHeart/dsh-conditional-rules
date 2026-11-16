// 持久化统计（src/stats.js）的契约测试。
// 运行：node tools/test-stats.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import stats.js 之前设置：它经由 rules.js 的 settingsPath() 决定落盘位置
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cond-stats-'))

const stats = await import('../src/stats.js')
const { settingsPath } = await import('../src/rules.js')
const statsFile = settingsPath().replace(/\.json$/, '-stats.json')

let passed = 0
function check (name, fn) {
  try {
    fn()
    passed++
    console.log(`ok  ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

const rule = (id, name) => ({ id, name })

check('记录后按命中次数降序返回', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 1)
  stats.recordHit('s1', [rule('a', '甲')], 2)
  stats.recordHit('s1', [rule('b', '乙')], 1)
  const list = stats.snapshot()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'a')
  assert.equal(list[0].total, 2)
  assert.equal(list[1].id, 'b')
  assert.equal(list[1].total, 1)
})

check('同一规则同一回合只记一次', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 3)
  stats.recordHit('s1', [rule('a', '甲')], 3)
  stats.recordHit('s1', [rule('a', '甲')], 3)
  assert.equal(stats.snapshot()[0].total, 1)
})

check('跨会话累加，sessions 去重计数', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 1)
  stats.recordHit('s2', [rule('a', '甲')], 1)
  stats.recordHit('s2', [rule('a', '甲')], 2)
  const item = stats.snapshot()[0]
  assert.equal(item.total, 3)
  assert.equal(item.sessions, 2)
})

check('事件明细含时间 / 会话 / 回合，且新的在前', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 1)
  stats.recordHit('s2', [rule('a', '甲')], 2)
  const events = stats.snapshot()[0].events
  assert.equal(events.length, 2)
  assert.equal(events[0].sessionId, 's2')
  assert.equal(events[0].turn, 2)
  assert.ok(events[0].at > 0)
})

check('事件明细最多保留 30 条', () => {
  stats.resetForTest()
  for (let turn = 1; turn <= 40; turn++) stats.recordHit('s1', [rule('a', '甲')], turn)
  const item = stats.snapshot()[0]
  assert.equal(item.total, 40)
  assert.equal(item.events.length, 30)
  assert.equal(item.events[0].turn, 40)
})

check('会话列表最多保留 50 个（总数仍然照加）', () => {
  stats.resetForTest()
  for (let i = 0; i < 60; i++) stats.recordHit('s' + i, [rule('a', '甲')], 1)
  const item = stats.snapshot()[0]
  assert.equal(item.total, 60)
  assert.equal(item.sessions, 50)
})

check('未命中过的规则不出现在看板里', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 1)
  assert.equal(stats.snapshot().length, 1)
})

check('flush 后能重新载入（持久化）', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 5)
  stats.flushStats()
  const raw = JSON.parse(readFileSync(statsFile, 'utf8'))
  assert.equal(raw.rules.a.total, 1)
  assert.equal(raw.rules.a.lastTurn, 5)

  stats.resetForTest()
  assert.equal(stats.snapshot().length, 0)
  stats.loadStats(null)
  const item = stats.snapshot()[0]
  assert.equal(item.id, 'a')
  assert.equal(item.total, 1)
})

check('清空统计会同时清掉落盘内容', () => {
  stats.resetForTest()
  stats.recordHit('s1', [rule('a', '甲')], 1)
  stats.clearStats()
  assert.equal(stats.snapshot().length, 0)
  const raw = JSON.parse(readFileSync(statsFile, 'utf8'))
  assert.deepEqual(raw.rules, {})
})

check('文件损坏时载入不抛错，退回空统计', () => {
  writeFileSync(statsFile, '{ not json', 'utf8')
  stats.resetForTest()
  stats.loadStats({ warn: () => {} })
  assert.deepEqual(stats.snapshot(), [])
})

check('脏数据被过滤（负数 / 未知字段）', () => {
  writeFileSync(statsFile, JSON.stringify({
    version: 1,
    rules: {
      ok: { name: '正常', total: 3, sessions: ['s1'], lastAt: 1000, lastTurn: 2, events: [{ at: 1000, sessionId: 's1', turn: 2 }] },
      bad: { name: '坏', total: -5, sessions: 'nope', events: 'nope' },
    },
  }), 'utf8')
  stats.resetForTest()
  stats.loadStats(null)
  const list = stats.snapshot()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'ok')
  assert.equal(list[0].total, 3)
})

console.log(`\n${passed} 项统计断言通过`)
