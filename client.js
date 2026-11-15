// dsh-conditional-rules — 浏览器半 / browser half
//
// 注册一个设置页（settings.section）：规则列表、规则编辑、试算。
// 契约：
//   · window.__ModuleLoader__.load({ id, factory }) —— id 必须等于包名
//   · factory 里的 require 只认白名单模块（react），不能 import 项目内相对路径
//   · 不 require 任何 @deepseek-ai/dsh-client-* 包
//   · 样式只用 --dsw-alias-* 主题 token，且都带 fallback
//   · 通用控件与样式来自共享 UI 基座（`// @ui-kit v…` 段）；改基座后跑
//     `node tools/sync-ui-kit.mjs` 同步，`node tools/check-ui-kit.mjs` 校验

window.__ModuleLoader__.load({
  id: 'dsh-conditional-rules',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // ═══ 1. 常量 ═══════════════════════════════════════════════════════
    const API = '/api/dsh-conditional-rules'
    const NS = 'conditionalInject'

    const DICTS = {
      zh: {
        nav: '条件规则',
        title: '条件规则',
        desc: '满足条件时自动把一段话注入对话；条件不变时不会重复注入。',
        'status.connecting': '连接中…',
        'status.unavailable': '不可用',
        'status.on': '已开启',
        'status.off': '已关闭',
        'count.rules': '{n} 条规则',
        'list.empty': '还没有规则。点「新增规则」开始。',
        'list.add': '新增规则',
        'rule.name': '名称',
        'rule.enabled': '启用',
        'rule.enabledDesc': '关闭后所有规则停止求值，设置仍保留',
        'rule.hits': '命中 {n} 次',
        'rule.edit': '编辑',
        'rule.done': '收起',
        'rule.remove': '删除',
        'rule.confirmRemove': '确认删除',
        'match.all': '全部满足',
        'match.any': '任一满足',
        'rule.conditions': '条件',
        'rule.always': '始终注入',
        'rule.noConditions': '没有条件：这条规则每次都会命中（内容不变时不会重复注入）',
        'rule.addCondition': '加条件',
        'rule.text': '注入内容',
        'rule.textPlaceholder': '条件满足时要注入的那段话',
        'rule.textHint': '点击下面的占位符插入到光标处',
        'rule.varInsert': '插入 {name}',
        'var.percent': '占用%',
        'var.used': '已用',
        'var.remaining': '剩余',
        'var.turn': '回合',
        'var.step': '步',
        'var.userText': '用户消息',
        'var.tool': '工具名',
        'var.ruleName': '规则名',
        'rule.limits': '触发限制',
        'rule.once': '每会话仅一次',
        'rule.onceDesc': '命中一次后本会话不再触发',
        'rule.cooldown': '冷却回合',
        'rule.cooldownDesc': '命中后 N 个回合内不再触发，0 表示不限',
        'rule.scope': '作用范围',
        'scope.global': '所有会话',
        'scope.project': '指定项目',
        'scope.session': '指定会话',
        'scope.valueProject': '项目目录名或完整路径',
        'scope.valueSession': '会话 id',
        'cond.context': '上下文占用',
        'cond.keyword': '用户关键词',
        'cond.turn': '回合数',
        'cond.tool': '工具调用',
        'cond.remove': '移除',
        'cond.always': '无条件',
        'cond.toAlways': '删掉这条条件，规则变为无条件',
        'op.gte': '≥',
        'op.lte': '≤',
        'op.between': '介于',
        'op.eq': '等于',
        'op.every': '每',
        'val.percent': '%',
        'val.turn': '回合',
        'ph.pattern': '正则，如 部署|上线',
        'ph.flags': '标志，如 i',
        'ph.toolName': '如 bash',
        'phase.before': '调用前',
        'phase.after': '调用后',
        'save': '保存',
        'saved': '已保存',
        'saveFailed': '保存失败',
        'saveIncomplete': '规则「{name}」的条件还没填完（关键词或工具名），填好并移开光标后才会保存',
        'unsaved': '未保存',
        'preview.title': '试算',
        'preview.subtitle': '用假状态看哪些规则会命中，不写进对话',
        'preview.expand': '展开',
        'preview.collapse': '收起',
        'preview.percent': '上下文占用 %',
        'preview.turn': '回合',
        'preview.userText': '用户消息',
        'preview.tool': '工具名',
        'preview.run': '试算',
        'preview.matched': '命中：{names}',
        'preview.none': '没有规则命中',
        'preview.output': '会注入的内容',
        'preview.running': '计算中…',
        'err.host': '无法连接宿主路由',
      },
      en: {
        nav: 'Conditional Rules',
        title: 'Conditional Rules',
        desc: 'Injects a block into the conversation when conditions match; unchanged text is not re-injected.',
        'status.connecting': 'Connecting…',
        'status.unavailable': 'Unavailable',
        'status.on': 'On',
        'status.off': 'Off',
        'count.rules': '{n} rules',
        'list.empty': 'No rules yet. Click "Add rule" to start.',
        'list.add': 'Add rule',
        'rule.name': 'Name',
        'rule.enabled': 'Enabled',
        'rule.enabledDesc': 'Turning this off stops evaluation; rules are kept',
        'rule.hits': 'Hit {n} times',
        'rule.edit': 'Edit',
        'rule.done': 'Collapse',
        'rule.remove': 'Delete',
        'rule.confirmRemove': 'Confirm delete',
        'match.all': 'All must hold',
        'match.any': 'Any holds',
        'rule.conditions': 'Conditions',
        'rule.always': 'Always',
        'rule.noConditions': 'No conditions: this rule fires every time (unchanged text is not re-injected)',
        'rule.addCondition': 'Add condition',
        'rule.text': 'Injected text',
        'rule.textPlaceholder': 'What to inject when the conditions match',
        'rule.textHint': 'Click a placeholder below to insert it at the cursor',
        'rule.varInsert': 'Insert {name}',
        'var.percent': 'usage %',
        'var.used': 'used',
        'var.remaining': 'left',
        'var.turn': 'turn',
        'var.step': 'step',
        'var.userText': 'user text',
        'var.tool': 'tool',
        'var.ruleName': 'rule name',
        'rule.limits': 'Trigger limits',
        'rule.once': 'Once per session',
        'rule.onceDesc': 'After one hit, never fires again in this session',
        'rule.cooldown': 'Cooldown turns',
        'rule.cooldownDesc': 'Do not fire again for N turns after a hit; 0 means no limit',
        'rule.scope': 'Scope',
        'scope.global': 'All sessions',
        'scope.project': 'Project',
        'scope.session': 'Session',
        'scope.valueProject': 'Project folder name or full path',
        'scope.valueSession': 'Session id',
        'cond.context': 'Context usage',
        'cond.keyword': 'User keyword',
        'cond.turn': 'Turn count',
        'cond.tool': 'Tool call',
        'cond.remove': 'Remove',
        'cond.always': 'Unconditional',
        'cond.toAlways': 'Remove this condition; the rule then fires unconditionally',
        'op.gte': '≥',
        'op.lte': '≤',
        'op.between': 'Between',
        'op.eq': '=',
        'op.every': 'Every',
        'val.percent': '%',
        'val.turn': 'turns',
        'ph.pattern': 'Regex, e.g. deploy|release',
        'ph.flags': 'Flags, e.g. i',
        'ph.toolName': 'e.g. bash',
        'phase.before': 'Before call',
        'phase.after': 'After call',
        'save': 'Save',
        'saved': 'Saved',
        'saveFailed': 'Save failed',
        'saveIncomplete': 'Rule "{name}" has an unfinished condition; fill it in and move focus away to save.',
        'unsaved': 'Unsaved',
        'preview.title': 'Dry run',
        'preview.subtitle': 'Test with fake state — nothing is written to the conversation',
        'preview.expand': 'Show',
        'preview.collapse': 'Hide',
        'preview.percent': 'Context usage %',
        'preview.turn': 'Turn',
        'preview.userText': 'User message',
        'preview.tool': 'Tool name',
        'preview.run': 'Run',
        'preview.matched': 'Matched: {names}',
        'preview.none': 'No rule matched',
        'preview.output': 'Text that would be injected',
        'preview.running': 'Calculating…',
        'err.host': 'Cannot reach the host route',
      },
    }

    /** 占位符替换。 */
    function fill (template, params) {
      if (typeof template !== 'string') return template
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    }

    let t = (key, params) => fill(DICTS.zh[key] === undefined ? key : DICTS.zh[key], params)

    const CONDITION_TYPES = ['context', 'keyword', 'turn', 'tool']
    const VARIABLES = ['percent', 'used', 'remaining', 'turn', 'step', 'userText', 'tool', 'ruleName']

    /** 新建一条空规则。 */
    function blankRule (index) {
      return {
        id: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: t('list.add') + ' ' + (index + 1),
        enabled: true,
        scope: { type: 'global' },
        match: 'all',
        conditions: [{ type: 'context', op: 'gte', value: 80 }],
        action: { text: '', once: false, cooldownTurns: 0 },
      }
    }

    // ═══ 2. store：轮询与写入 ══════════════════════════════════════════
    let state = {
      loading: true,
      error: null,
      version: '',
      settings: { enabled: true, rules: [] },
      sessions: [],
      hits: {},
    }
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn(state) }

    async function refresh () {
      try {
        const r = await fetch(API + '/state', { headers: { accept: 'application/json' } })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        state = {
          ...state,
          loading: false,
          error: null,
          version: j.version || '',
          settings: j.settings || state.settings,
          sessions: Array.isArray(j.sessions) ? j.sessions : [],
          hits: j.hits || {},
        }
      } catch (e) {
        state = { ...state, loading: false, error: (e && e.message) || t('err.host') }
      }
      emit()
    }

    async function save (rules, enabled) {
      const body = {}
      if (Array.isArray(rules)) body.rules = rules
      if (typeof enabled === 'boolean') body.enabled = enabled
      const r = await fetch(API + '/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let j = null
      try { j = await r.json() } catch { /* 非 JSON 按失败处理 */ }
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status))
      state = { ...state, settings: j.settings || state.settings, error: null }
      emit()
      return j
    }

    async function dryRun (payload) {
      const r = await fetch(API + '/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status))
      return j
    }

    function useStore () {
      const [snap, setSnap] = useState(state)
      useEffect(() => {
        listeners.add(setSnap)
        setSnap(state)
        return () => { listeners.delete(setSnap) }
      }, [])
      return snap
    }

    // ═══ 3. 样式（通用键来自共享基座，本插件只加特有键）═════════════════
    // @ui-kit v1.3.0  共享 UI 基座（源：plugins/_shared/ui-kit.js；改源后重新复制本段）
    // ═════════════════════════════ [C] 颜色 token ═════════════════════════
    const C = {
      border: 'var(--dsw-alias-border-subtle, rgba(130,130,140,0.28))',
      text: 'var(--dsw-alias-text-primary, inherit)',
      dim: 'var(--dsw-alias-text-secondary, rgba(140,140,150,1))',
      accent: 'var(--dsw-alias-accent, #4f7cff)',
      surface: 'var(--dsw-alias-surface-raised, rgba(130,130,140,0.06))',
      ok: 'var(--dsw-alias-success, #2f9e6b)',
      warn: 'var(--dsw-alias-warning, #c8862a)',
      danger: 'var(--dsw-alias-danger, #e5534b)',
      radius: 'var(--dsw-radius-lg, 12px)',
      radiusSm: 'var(--dsw-radius-sm, 8px)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    // ═════════════════════════ [S_BASE] 通用样式 ═════════════════════════
    // 插件用 `{ ...S_BASE, ...特有键 }` 组装自己的 S，特有键不要回填本文件。
    const S_BASE = {
      card: { border: '1px solid ' + C.border, borderRadius: C.radius, padding: '16px 18px', display: 'grid', gap: '14px', color: C.text },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      badge: { fontSize: '12px', color: C.dim, border: '1px solid ' + C.border, borderRadius: '999px', padding: '1px 8px' },
      status: { marginLeft: 'auto', fontSize: '12px', color: C.dim },
      desc: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: C.dim },
      /* 行布局自适应：空间不够时控件整体换到下一行，而不是把标题挤成一字一列 */
      row: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
      rowText: { display: 'grid', gap: '2px', flex: '1 1 200px', minWidth: '180px' },
      rowTitle: { fontSize: '13px', fontWeight: 550 },
      rowDesc: { fontSize: '12px', color: C.dim, lineHeight: 1.5 },
      field: { display: 'grid', gap: '4px' },
      label: { fontSize: '12px', color: C.dim },
      hint: { fontSize: '12px', color: C.dim, lineHeight: 1.5 },
      inline: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 1 auto', flexWrap: 'wrap', justifyContent: 'flex-end' },
      toggle: (on) => ({
        width: '38px', height: '22px', borderRadius: '999px', border: '1px solid ' + C.border,
        background: on ? C.accent : 'rgba(130,130,140,0.25)', position: 'relative', cursor: 'pointer',
        flex: 'none', marginTop: '2px', transition: 'background 160ms ease',
      }),
      knob: (on) => ({
        position: 'absolute', top: '2px', left: on ? '18px' : '2px', width: '16px', height: '16px',
        borderRadius: '50%', background: '#fff', transition: 'left 160ms ease',
      }),
      chip: (on) => ({
        padding: '3px 10px', fontSize: '12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid ' + (on ? C.accent : C.border),
        background: on ? C.accent : 'transparent',
        color: on ? '#fff' : C.dim,
      }),
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', minWidth: 0 },
      panel: { background: C.surface, borderRadius: C.radiusSm, padding: '12px 14px', display: 'grid', gap: '10px' },
      input: {
        width: '110px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm, background: 'transparent', color: C.text,
      },
      textarea: {
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6, padding: '8px 10px',
        resize: 'vertical', border: '1px solid ' + C.border, borderRadius: '6px',
        background: 'transparent', color: C.text, minHeight: '56px', width: '100%', boxSizing: 'border-box',
      },
      /* 文本输入：与 textarea 同族的全宽、等宽、左对齐；行内需要伸缩时在使用处加 flex */
      textInput: {
        width: '100%', boxSizing: 'border-box',
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6, padding: '7px 9px',
        border: '1px solid ' + C.border, borderRadius: '6px',
        background: 'transparent', color: C.text,
      },
      btn: (disabled) => ({
        padding: '5px 12px', fontSize: '13px', borderRadius: C.radiusSm,
        border: '1px solid ' + C.border, background: 'transparent', color: C.text,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, flex: 'none',
      }),
      link: { fontSize: '13px', padding: '5px 12px', borderRadius: C.radiusSm, border: '1px solid ' + C.border, background: 'transparent', color: C.text, cursor: 'pointer' },
      line: {
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6, wordBreak: 'break-all',
        background: 'rgba(130,130,140,0.12)', borderRadius: '6px', padding: '8px 10px', color: C.text,
      },
      empty: { fontSize: '12.5px', color: C.dim, fontStyle: 'italic' },
      msg: (bad) => ({ fontSize: '12px', color: bad ? C.danger : C.dim }),
      foot: { fontSize: '12px', color: C.dim, lineHeight: 1.6, margin: 0 },
      mono: { fontFamily: C.mono, wordBreak: 'break-all' },
      statItem: { display: 'grid', gap: '2px' },
      statValue: { fontSize: '18px', fontWeight: 600 },
      statKey: { fontSize: '12px', color: C.dim },
      range: { width: '100%', accentColor: C.accent, cursor: 'pointer' },
      sliderHead: { display: 'flex', alignItems: 'baseline', gap: '8px', justifyContent: 'space-between' },
      sliderValue: { fontSize: '13px', fontWeight: 600, fontFamily: C.mono },
    }

    // ═════════════════════════ [组件] 通用控件 ═════════════════════════
    /** 开关按钮。 */
    function Toggle ({ on, label, onChange }) {
      return h('button', {
        type: 'button',
        'aria-label': label,
        'aria-pressed': on ? 'true' : 'false',
        style: S.toggle(on),
        onClick: () => onChange(!on),
      }, h('span', { style: S.knob(on) }))
    }

    /** 一行设置：左标题与说明，右控件。 */
    function Row ({ title, desc, control }) {
      return h('div', { style: S.row },
        h('div', { style: S.rowText },
          h('div', { style: S.rowTitle }, title),
          desc ? h('div', { style: S.rowDesc }, desc) : null,
        ),
        control,
      )
    }

    /** 一行文本：有值显示内容，无值显示占位说明。 */
    function Line ({ text, placeholder }) {
      return text
        ? h('div', { style: S.line }, text)
        : h('div', { style: S.empty }, placeholder)
    }

    /** 标签 + 值（值默认等宽）。 */
    function Field ({ label, value, mono }) {
      return h('div', { style: S.field },
        h('span', { style: S.label }, label),
        h('span', { style: mono === false ? { fontSize: '12.5px' } : { fontFamily: C.mono, fontSize: '12.5px' } }, value),
      )
    }

    /** 百分比滑条。valueText 传当前值的可读形式（如 "30%"），不传则只显示标签。 */
    function Slider ({ label, value, min, max, step, hint, valueText, disabled, onChange }) {
      return h('div', { style: S.field },
        h('div', { style: S.sliderHead },
          h('span', { style: S.rowTitle }, label),
          valueText ? h('span', { style: S.sliderValue }, valueText) : null,
        ),
        h('input', {
          type: 'range',
          min,
          max,
          step,
          value: Number(value) || 0,
          style: S.range,
          'aria-label': label,
          disabled,
          onChange: (e) => onChange(Number(e.target.value)),
        }),
        hint ? h('span', { style: S.hint }, hint) : null,
      )
    }

    /** 数据卡片：一个数值 + 一句说明。 */
    function Stat ({ value, label }) {
      return h('div', { style: S.statItem },
        h('div', { style: S.statValue }, value),
        h('div', { style: S.statKey }, label),
      )
    }

    /** 互斥选项组（药丸按钮）。options 为 `[[value, label], ...]`。 */
    function ChipGroup ({ value, options, disabled, onChange }) {
      return h('div', { style: S.chips },
        options.map(([key, label]) => h('button', {
          key,
          type: 'button',
          style: S.chip(value === key),
          'aria-pressed': value === key ? 'true' : 'false',
          disabled,
          onClick: () => onChange(key, label),
        }, label))
      )
    }
    // 模板优先：通用键全部来自 S_BASE，这里只放本插件特有的结构样式。
    const S = {
      ...S_BASE,
      // 区块小标题：比标签重、比正文轻，用来分组而不是靠边框
      groupLabel: { fontSize: '12px', fontWeight: 600, color: C.dim },
      // 规则卡片：一条规则一张卡，头部整行可点开编辑
      ruleCard: { border: '1px solid ' + C.border, borderRadius: C.radiusSm, overflow: 'hidden' },
      ruleHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', flexWrap: 'wrap' },
      ruleHeadOpen: { background: C.surface },
      // 头部可点区域：撑满剩余宽度，但不包住开关与删除按钮（避免 button 嵌套）
      ruleHitArea: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        flex: '1 1 auto', minWidth: 0, cursor: 'pointer', padding: '2px 0',
      },
      chevron: { fontSize: '11px', color: C.dim, flex: 'none', minWidth: '10px' },
      ruleName: { fontSize: '13.5px', fontWeight: 600, minWidth: 0 },
      ruleMeta: { fontSize: '12px', color: C.dim },
      // 展开区：浅底，内部靠间距分组，不再套第二层边框
      ruleBody: { display: 'grid', gap: '16px', padding: '14px 16px', borderTop: '1px solid ' + C.border },
      // 占位符：蓝色可点，点一下插到光标处
      varList: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
      varItem: { display: 'inline-flex', alignItems: 'baseline', gap: '4px', maxWidth: '100%' },
      varChip: {
        fontFamily: C.mono, fontSize: '11.5px', padding: '2px 7px', borderRadius: '999px',
        border: '1px solid ' + C.accent, background: 'transparent', color: C.accent,
        cursor: 'pointer', flex: 'none', lineHeight: 1.5,
      },
      varDesc: { fontSize: '11.5px', color: C.dim },
      // 条件：左竖线表示从属，替掉原来的背景块
      condList: { display: 'grid', gap: '12px', paddingLeft: '12px', borderLeft: '2px solid ' + C.border },
      condHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      condParams: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      condIndex: { fontSize: '11.5px', color: C.dim, fontFamily: C.mono, minWidth: '16px' },
      numInput: {
        width: '68px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm,
        background: 'transparent', color: C.text,
      },
      // 按钮三档：主操作 / 次要 / 破坏
      primaryBtn: (disabled) => ({
        padding: '6px 16px', fontSize: '13px', fontWeight: 550, borderRadius: C.radiusSm,
        border: '1px solid ' + (disabled ? C.border : C.accent),
        background: disabled ? 'transparent' : C.accent,
        color: disabled ? C.dim : '#fff',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
      }),
      iconBtn: {
        width: '24px', height: '24px', padding: 0, lineHeight: 1, fontSize: '14px',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm,
        background: 'transparent', color: C.dim, cursor: 'pointer', flex: 'none',
      },
      toolbar: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', paddingTop: '10px' },
      toolbarSpacer: { marginLeft: 'auto' },
      bodyText: {
        fontFamily: C.mono, fontSize: '12.5px', lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'rgba(130,130,140,0.12)', borderRadius: '6px', padding: '8px 10px',
      },
      previewGrid: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' },
      // 追加条件的占位卡片：虚线框 + 居中加号，点整张卡都算点击
      addCondCard: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        width: '100%', padding: '10px 12px',
        border: '1px dashed ' + C.border, borderRadius: C.radiusSm,
        background: 'transparent', color: C.dim, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: '13px',
      },
      addCondPlus: { fontSize: '16px', lineHeight: 1, fontWeight: 600, color: C.accent },
    }

    // ═══ 4. 规则编辑 ═══════════════════════════════════════════════════
    /**
     * 一个条件：两段式——第一行选类型，第二行给参数。
     * 挤在一行时类型 chip、操作符、数值、删除按钮会混在一起，看不出层级。
     */
    function ConditionEditor ({ cond, index, onChange, onRemove, only }) {
      // 第二个参数 = 「这次改动要立刻落盘」：chip 这类离散切换即时保存，
      // 文本与数字输入等失焦再保存（commit）。界面上已没有保存按钮。
      const set = (patch, save) => onChange({ ...cond, ...patch }, save)
      const commit = () => onChange(cond, true)
      const ops = cond.type === 'turn' ? ['gte', 'lte', 'eq', 'every'] : ['gte', 'lte', 'between']
      const params = []

      if (cond.type === 'context' || cond.type === 'turn') {
        params.push(h(ChipGroup, {
          key: 'op',
          value: cond.op,
          options: ops.map((op) => [op, t('op.' + op)]),
          onChange: (op) => set({ op }, true),
        }))
        params.push(h('input', {
          key: 'v1',
          type: 'number', min: 0, max: cond.type === 'context' ? 100 : undefined, step: 1, style: S.numInput,
          value: cond.value, 'aria-label': t('cond.' + cond.type),
          onChange: (e) => set({ value: Number(e.target.value) }),
          onBlur: commit,
        }))
        if (cond.type === 'context' && cond.op === 'between') {
          params.push(h('span', { key: 'dash', style: S.hint }, '—'))
          params.push(h('input', {
            key: 'v2',
            type: 'number', min: 0, max: 100, style: S.numInput,
            value: cond.value2 === undefined ? 100 : cond.value2, 'aria-label': t('cond.context'),
            onChange: (e) => set({ value2: Number(e.target.value) }),
            onBlur: commit,
          }))
        }
        params.push(h('span', { key: 'unit', style: S.hint },
          cond.type === 'context' ? t('val.percent') : t('val.turn')))
      }

      if (cond.type === 'keyword') {
        params.push(h('input', {
          key: 'pattern',
          type: 'text', style: { ...S.textInput, flex: '1 1 200px', minWidth: '160px' },
          value: cond.pattern, placeholder: t('ph.pattern'), spellCheck: false,
          'aria-label': t('cond.keyword'),
          onChange: (e) => set({ pattern: e.target.value }),
          onBlur: commit,
        }))
        params.push(h('input', {
          key: 'flags',
          type: 'text', style: { ...S.textInput, width: '64px', flex: 'none' },
          value: cond.flags || '', placeholder: t('ph.flags'), spellCheck: false,
          'aria-label': t('ph.flags'),
          onChange: (e) => set({ flags: e.target.value }),
          onBlur: commit,
        }))
      }

      if (cond.type === 'tool') {
        params.push(h('input', {
          key: 'name',
          type: 'text', style: { ...S.textInput, flex: '1 1 160px', minWidth: '140px' },
          value: cond.name, placeholder: t('ph.toolName'), spellCheck: false,
          'aria-label': t('cond.tool'),
          onChange: (e) => set({ name: e.target.value }),
          onBlur: commit,
        }))
        params.push(h(ChipGroup, {
          key: 'phase',
          value: cond.phase,
          options: [['before', t('phase.before')], ['after', t('phase.after')]],
          onChange: (phase) => set({ phase }, true),
        }))
      }

      return h('div', { style: { display: 'grid', gap: '8px' } },
        h('div', { style: S.condHead },
          h('span', { style: S.condIndex }, '#' + (index + 1)),
          h(ChipGroup, {
            value: cond.type,
            options: CONDITION_TYPES.map((type) => [type, t('cond.' + type)]),
            onChange: (type) => {
              // 切类型只是本地编辑：新类型的参数还没填，立刻落盘会被服务端白名单丢掉条件，
              // 规则静默降级成「无条件」（2026-11-15 实测）。等参数填完失焦再保存。
              if (type === 'context') onChange({ type, op: 'gte', value: 80 }, false)
              else if (type === 'keyword') onChange({ type, pattern: '', flags: 'i' }, false)
              else if (type === 'turn') onChange({ type, op: 'gte', value: 1 }, false)
              else onChange({ type, name: '', phase: 'before' }, false)
            },
          }),
          h('span', { style: S.toolbarSpacer }),
          // 只剩一条条件时，删掉它就等于「无条件」——按钮直接写清后果，
          // 比一个 × 更贴近用户此刻的目的（2026-11-15 用户要求）
          h('button', {
            type: 'button', style: only ? S.link : S.iconBtn,
            title: only ? t('cond.toAlways') : t('cond.remove'),
            'aria-label': only ? t('cond.toAlways') : t('cond.remove'),
            onClick: onRemove,
          }, only ? t('cond.always') : '×'),
        ),
        h('div', { style: S.condParams }, ...params),
      )
    }

    /** 一条规则：折叠时是一张卡片的一行摘要，点头部展开编辑。 */
    function RuleEditor ({ rule, onChange, onRemove, hits }) {
      // 新建的空规则默认展开：用户点「新增规则」就是要立刻填内容
      const [open, setOpen] = useState(!rule.action.text)
      const [confirming, setConfirming] = useState(false)
      const textRef = useRef(null)
      // 插入占位符后要把光标落到插入点之后；渲染完成才能设置选区
      const pendingCursor = useRef(null)

      useEffect(() => {
        if (pendingCursor.current === null) return
        const el = textRef.current
        if (!el || typeof el.setSelectionRange !== 'function') {
          pendingCursor.current = null
          return
        }
        el.focus()
        el.setSelectionRange(pendingCursor.current, pendingCursor.current)
        pendingCursor.current = null
      })

      // 同上：save=true 表示这次改动可以立即落盘，文本输入类走失焦提交（commit）
      const set = (patch, save) => onChange({ ...rule, ...patch }, save)
      const setAction = (patch, save) => set({ action: { ...rule.action, ...patch } }, save)
      const commit = () => onChange(rule, true)
      const typeNames = rule.conditions.map((cond) => t('cond.' + cond.type))
      const summary = rule.conditions.length === 0
        ? t('rule.always')
        : typeNames.join(rule.match === 'any' ? ' 或 ' : ' 且 ')

      const toggleOpen = () => setOpen(!open)
      const onHeadKey = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        toggleOpen()
      }

      /** 在光标处插入占位符；没有光标（未聚焦过）就追加到末尾。 */
      const insertVar = (name) => {
        const token = '{{' + name + '}}'
        const text = rule.action.text || ''
        const el = textRef.current
        const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length
        const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : text.length
        setAction({ text: text.slice(0, start) + token + text.slice(end) })
        pendingCursor.current = start + token.length
      }

      return h('div', { style: S.ruleCard },
        h('div', { style: { ...S.ruleHead, ...(open ? S.ruleHeadOpen : {}) } },
          h(Toggle, {
            on: rule.enabled !== false,
            label: t('rule.enabled'),
            onChange: (v) => set({ enabled: v }, true),
          }),
          // 可点区域：点这里展开/收起。开关与删除在区域外，避免 button 嵌套
          h('div', {
            style: S.ruleHitArea,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open ? 'true' : 'false',
            title: open ? t('rule.done') : t('rule.edit'),
            onClick: toggleOpen,
            onKeyDown: onHeadKey,
          },
            h('span', { style: S.chevron }, open ? '▾' : '▸'),
            h('span', { style: S.ruleName }, rule.name || '—'),
            h('span', { style: S.ruleMeta }, summary || '—'),
            hits > 0 ? h('span', { style: S.badge }, t('rule.hits', { n: hits })) : null,
          ),
          confirming
            ? h('button', {
              type: 'button', style: { ...S.link, color: C.danger, borderColor: C.danger },
              onClick: onRemove,
            }, t('rule.confirmRemove'))
            : h('button', {
              type: 'button', style: S.iconBtn, title: t('rule.remove'), 'aria-label': t('rule.remove'),
              onClick: () => setConfirming(true),
            }, '×'),
        ),

        open
          ? h('div', { style: S.ruleBody },
            h('div', { style: S.field },
              h('span', { style: S.groupLabel }, t('rule.name')),
              h('input', {
                type: 'text', style: S.textInput, value: rule.name, spellCheck: false,
                'aria-label': t('rule.name'),
                onChange: (e) => set({ name: e.target.value }),
                onBlur: commit,
              }),
            ),

            h('div', { style: S.field },
              h('span', { style: S.groupLabel }, t('rule.scope')),
              h('div', { style: S.condParams },
                h(ChipGroup, {
                  value: rule.scope.type,
                  options: [['global', t('scope.global')], ['project', t('scope.project')], ['session', t('scope.session')]],
                  // 切作用域同理：project / session 还没填值时会退回 global，等填完再保存
                  onChange: (type) => set({ scope: type === 'global' ? { type } : { type, value: rule.scope.value || '' } }, false),
                }),
                rule.scope.type !== 'global'
                  ? h('input', {
                    type: 'text', style: { ...S.textInput, flex: '1 1 200px', minWidth: '160px' },
                    value: rule.scope.value || '',
                    placeholder: rule.scope.type === 'project' ? t('scope.valueProject') : t('scope.valueSession'),
                    spellCheck: false,
                    'aria-label': t('rule.scope'),
                    onChange: (e) => set({ scope: { type: rule.scope.type, value: e.target.value } }),
                    onBlur: commit,
                  })
                  : null,
              ),
            ),

            h('div', { style: S.field },
              h('div', { style: S.condParams },
                h('span', { style: S.groupLabel }, t('rule.conditions')),
                rule.conditions.length > 1
                  ? h(ChipGroup, {
                    value: rule.match,
                    options: [['all', t('match.all')], ['any', t('match.any')]],
                    onChange: (match) => set({ match }, true),
                  })
                  : null,
              ),
              h('div', { style: S.condList },
                ...(rule.conditions.length === 0
                  ? [h('div', { key: 'none', style: S.hint }, t('rule.noConditions'))]
                  : rule.conditions.map((cond, i) => h(ConditionEditor, {
                    key: i,
                    cond,
                    index: i,
                    only: rule.conditions.length === 1,
                    onChange: (next, save) => set({ conditions: rule.conditions.map((c, j) => (j === i ? next : c)) }, save),
                    onRemove: () => set({ conditions: rule.conditions.filter((_, j) => j !== i) }, true),
                  }))),
                // 追加条件做成一张占位卡片：虚线框 + 居中加号，接在最后一条条件下方
                h('button', {
                  key: 'add',
                  type: 'button',
                  style: S.addCondCard,
                  title: t('rule.addCondition'),
                  'aria-label': t('rule.addCondition'),
                  onClick: () => set({ conditions: [...rule.conditions, { type: 'context', op: 'gte', value: 80 }] }, true),
                },
                  h('span', { style: S.addCondPlus, 'aria-hidden': 'true' }, '+'),
                  h('span', {}, t('rule.addCondition')),
                ),
              ),
            ),

            h('div', { style: S.field },
              h('div', { style: S.condParams },
                h('span', { style: S.groupLabel }, t('rule.text')),
                h('span', { style: S.toolbarSpacer }),
                h('span', { style: S.hint }, t('rule.textHint')),
              ),
              h('textarea', {
                ref: textRef,
                style: { ...S.textarea, minHeight: '84px' },
                value: rule.action.text,
                placeholder: t('rule.textPlaceholder'),
                'aria-label': t('rule.text'),
                onChange: (e) => setAction({ text: e.target.value }),
                onBlur: commit,
              }),
              // 占位符：点一下就插到光标处，不必手打
              h('div', { style: S.varList },
                ...VARIABLES.map((name) => h('span', { key: name, style: S.varItem },
                  h('button', {
                    type: 'button',
                    style: S.varChip,
                    title: t('rule.varInsert', { name: '{{' + name + '}}' }),
                    onClick: () => insertVar(name),
                  }, '{{' + name + '}}'),
                  h('span', { style: S.varDesc }, t('var.' + name)),
                )),
              ),
            ),

            h('div', { style: S.field },
              h('span', { style: S.groupLabel }, t('rule.limits')),
              h(Row, {
                title: t('rule.once'),
                desc: t('rule.onceDesc'),
                control: h(Toggle, {
                  on: rule.action.once === true,
                  label: t('rule.once'),
                  onChange: (v) => setAction({ once: v }, true),
                }),
              }),
              h(Row, {
                title: t('rule.cooldown'),
                desc: t('rule.cooldownDesc'),
                control: h('input', {
                  type: 'number', min: 0, step: 1, style: S.numInput,
                  value: rule.action.cooldownTurns || 0, 'aria-label': t('rule.cooldown'),
                  onChange: (e) => setAction({ cooldownTurns: Number(e.target.value) }),
                  onBlur: commit,
                }),
              }),
            ),
          )
          : null,
      )
    }

    // ═══ 5. 试算 ═══════════════════════════════════════════════════════
    /** 试算区：默认收起，展开后用一个两列表单，避免最后一个字段孤零零占一行。 */
    function PreviewPanel ({ rules }) {
      const [open, setOpen] = useState(false)
      const [input, setInput] = useState({ percent: 85, turn: 3, userText: '', tool: '' })
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)

      const run = useCallback(async () => {
        setBusy(true)
        setErr(null)
        try {
          const j = await dryRun({ ...input, rules })
          setResult(j)
        } catch (e) {
          setErr((e && e.message) || t('err.host'))
        } finally {
          setBusy(false)
        }
      }, [input, rules])

      const field = (key, label, type, span) => h('div', { style: { ...S.field, gridColumn: span ? '1 / -1' : undefined } },
        h('span', { style: S.label }, label),
        h('input', {
          type: type || 'text',
          style: type === 'number' ? S.numInput : S.textInput,
          value: input[key],
          'aria-label': label,
          onChange: (e) => setInput({ ...input, [key]: type === 'number' ? Number(e.target.value) : e.target.value }),
        }),
      )

      const head = h('div', { style: S.ruleHead },
        h('span', { style: S.groupLabel }, t('preview.title')),
        h('span', { style: S.ruleMeta }, t('preview.subtitle')),
        h('span', { style: S.toolbarSpacer }),
        open
          ? h('div', { style: S.condParams },
            h('button', { type: 'button', style: S.link, disabled: busy, onClick: run },
              busy ? t('preview.running') : t('preview.run')),
            h('button', { type: 'button', style: S.link, onClick: () => setOpen(false) }, t('preview.collapse')),
          )
          : h('button', { type: 'button', style: S.link, onClick: () => setOpen(true) }, t('preview.expand')),
      )

      if (!open) return h('div', { style: S.ruleCard }, head)

      return h('div', { style: S.ruleCard },
        head,
        h('div', { style: S.previewGrid },
          field('percent', t('preview.percent'), 'number'),
          field('turn', t('preview.turn'), 'number'),
          field('tool', t('preview.tool')),
          field('userText', t('preview.userText'), 'text', true),
        ),
        err ? h('div', { style: S.msg(true) }, err) : null,
        result
          ? h('div', { style: S.field },
            h('span', { style: S.label }, t('preview.output')),
            h('span', { style: S.hint },
              result.matched && result.matched.length > 0
                ? t('preview.matched', { names: String(result.matched.length) })
                : t('preview.none')),
            result.text
              ? h('div', { style: S.bodyText }, result.text)
              : null,
          )
          : null,
      )
    }

    // ═══ 6. 设置页 ═════════════════════════════════════════════════════
    function SettingsPage () {
      const snap = useStore()
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState(null)
      // 每次保存一个序号：早发起的响应回来时若已有更晚的保存，直接丢弃，
      // 否则前一次的 setDraft(null) 会盖掉后一次正在编辑的内容
      const saveSeq = useRef(0)

      // 服务端值变化时同步本地草稿（用户未编辑时）
      useEffect(() => {
        if (draft === null) setDraft(snap.settings.rules || [])
      }, [snap.settings.rules, draft])

      const rules = draft === null ? (snap.settings.rules || []) : draft

      // 没有注入文本的规则不落盘：新建的卡要等用户填完才有意义。
      // 让空草稿进 /set 会被白名单丢弃，随后刷新的界面会把用户正在编辑的卡删掉。
      const isBlank = (rule) => !(rule && rule.action && typeof rule.action.text === 'string' && rule.action.text.trim())

      // 参数还没填完的条件：此刻落盘会被服务端白名单丢掉条件，规则静默降级成「无条件」。
      // 拦住这次保存并说明是哪条规则，等用户填完（失焦）再发。
      const unfinished = (rule) => {
        const pending = rule && Array.isArray(rule.conditions) && rule.conditions.some((cond) => {
          if (!cond || typeof cond !== 'object') return false
          if (cond.type === 'keyword') return !String(cond.pattern || '').trim()
          if (cond.type === 'tool') return !String(cond.name || '').trim()
          return false
        })
        if (pending) return true
        const scope = (rule && rule.scope) || {}
        return Boolean(scope.type && scope.type !== 'global' && !String(scope.value || '').trim())
      }

      /** 自动保存：成功静默（每改一处都保存，弹提示会闪），失败才报错。 */
      const persist = async (nextRules, nextEnabled) => {
        const blocked = nextRules.find((rule) => unfinished(rule))
        if (blocked) {
          setMsg({ text: t('saveIncomplete', { name: blocked.name || '' }), bad: true })
          return
        }
        const seq = ++saveSeq.current
        try {
          await save(nextRules.filter((rule) => !isBlank(rule)), nextEnabled)
          if (seq !== saveSeq.current) return
          setMsg(null)
          refresh()
          // 草稿里没有空白卡时才交还给服务端快照，避免刚新建的卡被刷掉
          if (nextRules.every((rule) => !isBlank(rule))) setDraft(null)
        } catch (e) {
          if (seq !== saveSeq.current) return
          setMsg({ text: (e && e.message) || t('saveFailed'), bad: true })
        }
      }

      const enabled = snap.settings.enabled !== false
      const statusText = snap.loading
        ? t('status.connecting')
        : snap.error ? t('status.unavailable') : (enabled ? t('status.on') : t('status.off'))

      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, t('title')),
          h('span', { style: S.badge }, 'v' + (snap.version || '—')),
          h('span', { style: S.badge }, t('count.rules', { n: rules.length })),
          h('span', { style: S.status }, statusText),
        ),
        h('p', { style: S.desc }, t('desc')),

        // 总开关单独一行：它立即生效，和「保存规则」不是同一件事，不能混在一起
        h(Row, {
          title: t('rule.enabled'),
          desc: t('rule.enabledDesc'),
          control: h(Toggle, {
            on: enabled,
            label: t('rule.enabled'),
            onChange: (v) => persist(undefined, v),
          }),
        }),

        rules.length === 0
          ? h('div', { style: S.hint }, t('list.empty'))
          : rules.map((rule, i) => h(RuleEditor, {
            key: rule.id || i,
            rule,
            hits: snap.hits && rule.id ? snap.hits[rule.id] || 0 : 0,
            onChange: (next, doSave) => {
              const nextRules = rules.map((r, j) => (j === i ? next : r))
              setDraft(nextRules)
              if (doSave) persist(nextRules)
            },
            onRemove: () => {
              const nextRules = rules.filter((_, j) => j !== i)
              setDraft(nextRules)
              persist(nextRules)
            },
          })),

        // 新增规则：与「加条件」同一款虚线卡片。新建的空白卡不落盘，等填了注入文本再存
        h('button', {
          type: 'button',
          style: S.addCondCard,
          title: t('list.add'),
          'aria-label': t('list.add'),
          onClick: () => setDraft([...rules, blankRule(rules.length)]),
        },
          h('span', { style: S.addCondPlus, 'aria-hidden': 'true' }, '+'),
          h('span', {}, t('list.add')),
        ),

        h(PreviewPanel, { rules }),

        msg ? h('div', { style: S.msg(msg.bad) }, msg.text) : null,
      )
    }

    // ═══ 7. 注册 ═══════════════════════════════════════════════════════
    function contribute (ctx, key, options, Component, what) {
      const fail = (e) => console.error(LOG, 'could not register ' + what + ':', e)
      try {
        return ctx.slots.inject(key, () => {
          try {
            return ctx.slots.register(options, Component)
          } catch (e) {
            fail(e)
            return () => {}
          }
        })
      } catch (e) {
        fail(e)
        return () => {}
      }
    }

    const LOG = '[dsh-conditional-rules]'
    const inject = ['slots', 'locale']

    function apply (ctx) {
      if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'cond-inject-dicts')
        t = ctx.locale.bind(NS)
      } else {
        console.warn(LOG, 'locale 服务不可用：界面文案固定中文')
      }

      ctx.effect(() => {
        refresh()
        const timer = setInterval(() => { if (!document.hidden) refresh() }, 8000)
        const onVisible = () => { if (!document.hidden) refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, 'cond-inject-poll')

      ctx.effect(
        () => contribute(
          ctx,
          'settings.section',
          { name: 'settings.section', id: 'conditional-inject', order: 255, locale: NS, label: () => t('nav') },
          SettingsPage,
          'settings.section'
        ),
        'cond-inject-settings-section'
      )
    }

    return { inject, apply }
  },
})
