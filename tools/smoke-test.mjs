// 结构自洽检查：交付物自身是否一致（不依赖宿主运行）。
// 运行：node tools/smoke-test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))

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

const pkg = readJson('package.json')
const clientSrc = fs.existsSync(path.join(ROOT, 'client.js')) ? read('client.js') : ''

check('package.json 名字与目录一致', () => {
  assert.equal(pkg.name, path.basename(ROOT))
})

check('发布就绪：无 @local/、有 license 与 keywords', () => {
  assert.ok(!pkg.name.startsWith('@local/'))
  assert.equal(pkg.private, undefined)
  assert.ok(pkg.license)
  assert.ok(pkg.author)
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'))
})

check('files 白名单覆盖入口、客户端与 bundle', () => {
  const files = pkg.files || []
  for (const need of ['index.js', 'client.js', 'src', 'cordis.patch.yml']) {
    assert.ok(files.includes(need), `files 缺少 ${need}`)
  }
})

check('client.js 的模块 id 等于包名', () => {
  const m = clientSrc.match(/id:\s*'([^']+)'/)
  assert.ok(m, '未找到 id')
  assert.equal(m[1], pkg.name)
})

// S / C 引用键：S 的键一部分来自基座段的 S_BASE，两块合并才算完整
check('client.js 的 S / C 引用键都有定义', () => {
  const blocks = {
    S: [clientSrc.match(/const S = \{([\s\S]*?)\n {4}\}\n/), clientSrc.match(/const S_BASE = \{([\s\S]*?)\n {4}\}\n/)],
    C: [clientSrc.match(/const C = \{([\s\S]*?)\n {4}\}\n/)],
  }
  for (const [label, candidates] of Object.entries(blocks)) {
    const found = candidates.filter(Boolean)
    assert.ok(found.length > 0, `${label} 样式对象未定位到`)
    const defined = new Set(found.flatMap((b) => [...b[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1])))
    const used = new Set([...clientSrc.matchAll(new RegExp(`\\b${label}\\.([A-Za-z][A-Za-z0-9]*)`, 'g'))].map((m) => m[1]))
    const missing = [...used].filter((key) => !defined.has(key))
    assert.deepEqual(missing, [], `${label} 未定义：${missing.join(', ')}`)
  }
})

check('条件区交互：单条件写「无条件」、追加条件用虚线卡片', () => {
  // 只剩一条条件时，删除按钮换文字——用户看不出「删掉即无条件」时就是这样踩空的
  assert.match(clientSrc, /only \? t\('cond\.always'\) : '×'/, '单条件按钮文案丢了')
  assert.match(clientSrc, /only: rule\.conditions\.length === 1/, 'only 标志没传给 ConditionEditor')
  assert.match(clientSrc, /only \? S\.link : S\.iconBtn/, '单条件按钮应改用文字按钮样式')
  // 追加条件做成占位卡片：虚线框 + 居中加号，文字保留
  assert.match(clientSrc, /addCondCard:/, '缺少 addCondCard 样式')
  assert.match(clientSrc, /border: '1px dashed ' \+ C\.border/, '追加卡片不是虚线框')
  assert.match(clientSrc, /S\.addCondPlus/, '缺少加号样式引用')
  assert.match(clientSrc, /S\.addCondCard/, '卡片样式未被引用')
  // 界面字典是内联的，中英各一份；新增文案必须两边都补齐
  for (const key of ['cond.always', 'cond.toAlways']) {
    const count = [...clientSrc.matchAll(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))].length
    assert.equal(count, 2, `${key} 应在中英字典各出现一次，实际 ${count}`)
  }
})

check('设置页自动保存：无保存按钮，失焦与离散控件各自落盘', () => {
  assert.ok(!/t\('save'\)/.test(clientSrc), '保存按钮应已移除')
  assert.ok(!/t\('unsaved'\)/.test(clientSrc), '未保存提示应已移除')
  assert.ok(!/\bdirty\b/.test(clientSrc), 'dirty 状态应已移除')
  assert.ok(clientSrc.includes('onBlur: commit'), '文本输入应失焦提交')
  assert.ok(clientSrc.includes('const commit = () => onChange(rule, true)'), '规则级 commit 不在了')
  assert.ok(clientSrc.includes('if (doSave) persist(nextRules)'), '离散改动应立即保存')
  assert.ok(clientSrc.includes('saveSeq.current'), '缺少保存序号防护（并发响应会互相覆盖）')
  assert.ok(clientSrc.includes('nextRules.filter((rule) => !isBlank(rule))'), '空草稿应被过滤，不能落盘')
  // 新增规则与加条件共用同一款虚线卡片
  const cards = [...clientSrc.matchAll(/style: S\.addCondCard/g)].length
  assert.equal(cards, 2, `新增规则与加条件应各用一次虚线卡片，实际 ${cards}`)
})

check('切换条件类型不会立刻落盘（防服务端丢条件降级成无条件）', () => {
  // 切 keyword / tool 时参数为空，立刻保存会被白名单吞掉整条条件
  assert.ok(clientSrc.includes("else if (type === 'keyword') onChange({ type, pattern: '', flags: 'i' }, false)"),
    '切换条件类型必须传 save=false')
  assert.ok(clientSrc.includes("else onChange({ type, name: '', phase: 'before' }, false)"),
    '切到工具触发必须传 save=false')
  assert.ok(clientSrc.includes('const blocked = nextRules.find((rule) => unfinished(rule))'),
    '缺少「未填完就不保存」的前置校验')
  assert.ok(clientSrc.includes("t('saveIncomplete'"), '缺少未填完的提示文案')
})

check('locale 双语齐全且键一致', () => {
  const zh = readJson('locale/zh.json')
  const en = readJson('locale/en.json')
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    assert.ok(dict.meta && dict.meta.title, `${name} 缺 meta.title`)
    assert.ok(dict.meta.description, `${name} 缺 meta.description`)
  }
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort())
})

check('cordis.patch.yml 声明了本插件的 insert 行', () => {
  const patch = read('cordis.patch.yml')
  assert.ok(/insert:/.test(patch))
  assert.ok(patch.includes(`id: ${pkg.name}`), 'patch 行 id 与包名不一致')
  assert.ok(patch.includes(`name: '${pkg.name}'`))
})

check('src 下的模块清单符合预期（无模板遗留）', () => {
  const expected = ['conditions.js', 'constants.js', 'match.js', 'render.js', 'routes.js', 'rules.js', 'session-state.js', 'stats.js', 'tool.js', 'trace.js']
  const actual = fs.readdirSync(path.join(ROOT, 'src')).filter((n) => n.endsWith('.js')).sort()
  assert.deepEqual(actual, expected.sort())
})

// 入口在异步里验证（ESM 动态 import）
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
check('入口导出 name / apply / inject', () => {
  assert.equal(mod.name, pkg.name)
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('systemPrompt'))
})

console.log(`\n${passed}/${passed} passed`)
