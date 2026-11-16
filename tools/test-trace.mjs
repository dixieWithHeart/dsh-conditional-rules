// 最近注入记录（src/trace.js）的契约测试。
// 运行：node tools/test-trace.mjs
import assert from 'node:assert/strict'

import { TRACE_MAX_ENTRIES, TRACE_MAX_TEXT } from '../src/constants.js'
import { clear, list, record, size } from '../src/trace.js'

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

const rule = (name) => ({ name })

check('记录后能按「新的在前」读到', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: '第一条', at: 1000 })
  record({ sessionId: 's1', rules: [rule('B')], text: '第二条', at: 2000 })
  const entries = list()
  assert.equal(entries.length, 2)
  assert.equal(entries[0].text, '第二条')
  assert.equal(entries[1].text, '第一条')
  assert.equal(entries[0].sessionId, 's1')
  assert.deepEqual(entries[0].rules, ['B'])
})

check('同会话 + 同规则 + 同文本：不新增条目，累加命中数', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: '同样的内容', at: 1000 })
  record({ sessionId: 's1', rules: [rule('A')], text: '同样的内容', at: 1500 })
  assert.equal(size(), 1)
  assert.equal(list()[0].hits, 2)
})

check('会话不同则不合并', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: '内容' })
  record({ sessionId: 's2', rules: [rule('A')], text: '内容' })
  assert.equal(size(), 2)
})

check('规则集合不同则不合并', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: '内容' })
  record({ sessionId: 's1', rules: [rule('A'), rule('B')], text: '内容' })
  assert.equal(size(), 2)
})

check('超长文本按上限截断', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: 'x'.repeat(TRACE_MAX_TEXT + 100) })
  assert.equal(list()[0].text.length, TRACE_MAX_TEXT)
})

check('空文本 / 空规则名不抛错', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('')], text: '   ' })
  assert.equal(size(), 1)
  record({ sessionId: 's1', rules: [rule('A')], text: '' })
  record({ sessionId: 's1', rules: [rule('A')], text: null })
  assert.equal(size(), 1)
})

check('条数上限：超出后丢弃最旧的', () => {
  clear()
  for (let i = 0; i < TRACE_MAX_ENTRIES + 10; i++) {
    record({ sessionId: 's1', rules: [rule('R' + i)], text: '内容 ' + i })
  }
  assert.equal(size(), TRACE_MAX_ENTRIES)
  assert.equal(list()[0].text, '内容 ' + (TRACE_MAX_ENTRIES + 9))
})

check('list 返回副本，外部改动不影响内部', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: '内容' })
  const first = list()
  first[0].text = '被改掉'
  first[0].rules.push('X')
  assert.equal(list()[0].text, '内容')
  assert.deepEqual(list()[0].rules, ['A'])
})

check('clear 清空记录', () => {
  clear()
  record({ sessionId: 's1', rules: [rule('A')], text: '内容' })
  assert.equal(size(), 1)
  clear()
  assert.equal(size(), 0)
  assert.deepEqual(list(), [])
})

console.log(`\n${passed} 项 trace 断言通过`)
