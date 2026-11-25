// t405 —— 工具用量（批次396）
//
// 为什么测这些：批次395 我拿 记忆/工具调用.jsonl 判「12 个工具零调用」，报给主人了。
// 那个账本靠劫持 tools.register 记账，只覆盖「插件自己注册之后、走同一个 tools 服务」的工具 ——
// 实测会话流里 56 种工具，账本只记了 26 种，漏掉 30 种，包括使用量最大的
// memory_update 533 次 / memory_remember 449 / memory_judge 435，以及
// web_search 20 / read_animation 7 / search_meme_wiki 18 全都没记。
// 也就是说「零调用」这个判据本身在骗人，上一批的结论整批作废。
//
// 这个文件锁的是新判据 工具用量.mjs（从宿主 stream.jsonl 派生）：
//   A 数得对：次数 / 按天 / 按会话 / 对象形式的 tool 字段 / 坏行不崩
//   B 窗口：窗口外的一律不算
//   C 白名单：零调用 = 白名单里有、窗口内没出现；名单外还在用的要单独列出来
//   D 落盘：原子写（不留 .tmp）；读不到会话流时**不许**覆盖上一份好数据
//
// 跑法：node --test t405.工具用量.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const TOOLS = '/data/hajimi-workspace/共享/工具'
const 脚本 = join(TOOLS, '工具用量.mjs')

const 京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 天 = 86400e3

/** 造沙盒：<根>/hippo/<sid>/stream.jsonl + <根>/记忆 + <根>/config.json */
function 造沙盒({ 会话们 = {}, 白名单 = [], 已有用量 = null }) {
  const 根 = mkdtempSync(join(tmpdir(), 't405-'))
  mkdirSync(join(根, '记忆'), { recursive: true })
  mkdirSync(join(根, 'hippo'), { recursive: true })
  for (const [sid, 行们] of Object.entries(会话们)) {
    mkdirSync(join(根, 'hippo', sid), { recursive: true })
    writeFileSync(join(根, 'hippo', sid, 'stream.jsonl'), 行们.join('\n') + '\n', 'utf8')
  }
  writeFileSync(join(根, 'config.json'), JSON.stringify({ 工具白名单: 白名单 }), 'utf8')
  if (已有用量) writeFileSync(join(根, '记忆', '工具用量.json'), 已有用量, 'utf8')
  return 根
}

/** 造一行工具调用。tool 可以是字符串，也可以是 { name } 对象。 */
function 行(ms, 工具, 额外 = {}) {
  return JSON.stringify({ ts: ms, who: 'act', sid: 's', tool: 工具, type: 'tool/call', ...额外 })
}

function 跑(根, argv = []) {
  const r = execFileSync(process.execPath, [脚本, '--静', ...argv], {
    encoding: 'utf8',
    timeout: 45e3,
    env: {
      ...process.env,
      USAGE_HOME: join(根, 'hippo'),
      USAGE_MEM: join(根, '记忆'),
      USAGE_CONFIG: join(根, 'config.json'),
    },
  })
  return { 出: readFileSync(join(根, '记忆', '工具用量.json'), 'utf8'), stdout: r }
}

function 跑失败(根, argv = []) {
  try {
    execFileSync(process.execPath, [脚本, '--静', ...argv], {
      encoding: 'utf8',
      timeout: 45e3,
      env: {
        ...process.env,
        USAGE_HOME: join(根, 'hippo'),
        USAGE_MEM: join(根, '记忆'),
        USAGE_CONFIG: join(根, 'config.json'),
      },
    })
    return { code: 0, stderr: '' }
  } catch (e) {
    return { code: e.status, stderr: String(e.stderr || '') }
  }
}

const 现在 = Date.now()

test('A1 次数数得对，且按次数降序', () => {
  const 根 = 造沙盒({
    会话们: {
      'session-a': [行(现在 - 1000, 'qq_send'), 行(现在 - 2000, 'qq_send'), 行(现在 - 3000, 'bash')],
      'session-b': [行(现在 - 4000, 'qq_send')],
    },
  })
  try {
    const d = JSON.parse(跑(根).出)
    assert.equal(d.按工具.qq_send.次, 3, '两个会话里的 qq_send 要合并计数')
    assert.equal(d.按工具.bash.次, 1)
    assert.deepEqual(Object.keys(d.按工具), ['qq_send', 'bash'], '必须按次数降序')
    assert.ok(d.按工具.qq_send.最后, '要带最后调用时间')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A2 tool 是 { name } 对象也要数得出来（宿主工具两种形态都见过）', () => {
  const 根 = 造沙盒({
    会话们: { 'session-a': [行(现在 - 1000, { name: 'memory_judge' }), 行(现在 - 2000, 'read_animation')] },
  })
  try {
    const d = JSON.parse(跑(根).出)
    assert.equal(d.按工具.memory_judge?.次, 1, '{name} 形态没数出来')
    assert.equal(d.按工具.read_animation?.次, 1)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A3 按天 / 按会话 分组都在', () => {
  const 今天 = 现在 - 1000
  const 昨天 = 现在 - 天 - 1000
  const 根 = 造沙盒({
    会话们: {
      'session-a': [行(今天, 'qq_send'), 行(昨天, 'qq_send')],
      'session-b': [行(今天, 'bash')],
    },
  })
  try {
    const d = JSON.parse(跑(根).出)
    const 日们 = Object.keys(d.按天).sort()
    assert.equal(日们.length, 2, '两个不同的日子要各占一行')
    assert.equal(d.按会话['session-a'].qq_send, 2)
    assert.equal(d.按会话['session-b'].bash, 1)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A4 坏行不崩，并计入坏行数（账本以前就是被坏行静默弄脏的）', () => {
  const 根 = 造沙盒({
    会话们: {
      'session-a': [行(现在 - 1000, 'qq_send'), '{这不是 JSON', '{"ts":1}'],
    },
  })
  try {
    const d = JSON.parse(跑(根).出)
    assert.equal(d.按工具.qq_send.次, 1)
    assert.ok(d.坏行数 >= 1, '坏行要记数，不能装作没发生')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('B1 窗口外的一律不算（--天 决定窗口，不是「全部历史」）', () => {
  const 根 = 造沙盒({
    会话们: {
      'session-a': [行(现在 - 1000, 'qq_send'), 行(现在 - 9 * 天, 'qq_recall')],
    },
  })
  try {
    const d = JSON.parse(跑(根, ['--天', '7']).出)
    assert.equal(d.按工具.qq_send.次, 1)
    assert.equal(d.按工具.qq_recall, undefined, '9 天前的调用不该出现在 7 天窗口里')
    assert.equal(d.窗口天, 7)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('C1 零调用 = 白名单里有、窗口内没出现；名单外还在用的单独列', () => {
  const 根 = 造沙盒({
    会话们: { 'session-a': [行(现在 - 1000, 'qq_send'), 行(现在 - 2000, 'bash')] },
    白名单: ['qq_send', 'qq_recall', 'qq_work'],
  })
  try {
    const d = JSON.parse(跑(根).出)
    assert.deepEqual(d.零调用.sort(), ['qq_recall', 'qq_work'], '白名单里没用过的要报出来')
    assert.deepEqual(d.名单外, ['bash'], 'bash 不在白名单但在用，要单独列（宿主工具）')
    assert.equal(d.白名单, 3)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('C2 没有配置白名单时，零调用为空而不是把全部工具报成零调用', () => {
  const 根 = 造沙盒({
    会话们: { 'session-a': [行(现在 - 1000, 'qq_send')] },
    白名单: [],
  })
  try {
    const d = JSON.parse(跑(根).出)
    assert.deepEqual(d.零调用, [])
    assert.deepEqual(d.名单外, [], '白名单为空时不该把用过的工具全列成「名单外」')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('D1 原子写：落盘成功后不留 .tmp', () => {
  const 根 = 造沙盒({ 会话们: { 'session-a': [行(现在 - 1000, 'qq_send')] } })
  try {
    跑(根)
    assert.equal(existsSync(join(根, '记忆', '工具用量.json')), true)
    assert.equal(existsSync(join(根, '记忆', '工具用量.json.tmp')), false, '临时文件没清掉')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('D2 读不到会话流时不许覆盖上一份好数据（覆盖成「全都是 0」比不更新更糟）', () => {
  const 旧 = JSON.stringify({ 生成于: '2026-11-14 01:00', 按工具: { qq_send: { 次: 999 } } })
  const 根 = 造沙盒({ 会话们: {}, 已有用量: 旧 })
  try {
    const r = 跑失败(根)
    assert.equal(r.code, 0, '还没有会话流应静默 exit 0（不刷心跳红字）')
    assert.equal(readFileSync(join(根, '记忆', '工具用量.json'), 'utf8'), 旧, '旧数据被覆盖了')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('D3 顶层字段齐全（面板/体检靠这些字段）', () => {
  const 根 = 造沙盒({ 会话们: { 'session-a': [行(现在 - 1000, 'qq_send')] }, 白名单: ['qq_send'] })
  try {
    const d = JSON.parse(跑(根).出)
    for (const k of ['生成于', '窗口天', '窗口起', '窗口止', '数据源', '扫描行数', '工具行数', '坏行数', '按工具', '按天', '按会话', '白名单', '零调用', '名单外']) {
      assert.ok(k in d, '缺字段 ' + k)
    }
    assert.ok(Array.isArray(d.数据源) && d.数据源.length === 1, '数据源要能看出读了哪几个会话流')
    assert.equal(d.数据源[0].会话, 'session-a')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('E1 体检-闭环 的 C 节已经改成读 工具用量.json（不许再只看账本）', () => {
  const 源 = readFileSync(join(TOOLS, '体检-闭环.mjs'), 'utf8')
  assert.ok(源.includes('工具用量.json'), '体检没接 工具用量.json')
  assert.ok(/数据源/.test(源), '输出里要标明数据源，否则看不出这份判断可不可信')
  assert.ok(源.includes('用量源'), '要有一个变量记住「这次判断用的是什么数据源」')
})

test('E2 toolrecord.js 里写明了「这个账本不完整」（防止下一个人再拿它判零调用）', () => {
  const LIB = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const 源 = readFileSync(join(LIB, 'toolrecord.js'), 'utf8')
  assert.ok(源.includes('SCOPE'), '缺 SCOPE 说明')
  assert.ok(源.includes('工具用量.json'), '要指向正确的判据')
})

test('E3 SOUL.md 里 qq_recall / qq_work 有指引（这两个工具上线至今零调用，因为从没写进过人设）', () => {
  const 人设 = readFileSync('/data/hajimi-workspace/SOUL.md', 'utf8')
  assert.ok(人设.includes('qq_recall'), 'qq_recall 没写进人设')
  assert.ok(人设.includes('qq_work'), 'qq_work 没写进人设')
  // 顺手锁住那个被实测推翻的旧结论
  assert.ok(!人设.includes('每回合重读，不用重启'), '「不用重启」是被实测推翻的结论，不许写回去')
  assert.ok(人设.includes('改完要重启才生效'), '必须写明改完要重启')
})

test('E4 体检的「注册」口径必须扫全部 lib 文件（只扫 tool.js 会漏掉 recall/work/go/photo… 9 个文件）', () => {
  const 源 = readFileSync(join(TOOLS, '体检-闭环.mjs'), 'utf8')
  assert.ok(/REG_SCOPE/.test(源), '缺 REG_SCOPE 说明')
  assert.ok(!/读\(join\(LIB, 'tool\.js'\)\)\.matchAll/.test(源), '还在只扫 tool.js')
  assert.ok(/f\.startsWith\('lib\/'\)/.test(源), '应该遍历 全库 里的 lib/*.js')
})

test('E5 体检 C 节要把「没下发」单独列（不再把不可能调用的工具报成零调用）', () => {
  const 源 = readFileSync(join(TOOLS, '体检-闭环.mjs'), 'utf8')
  assert.ok(源.includes('未下发'), '没有区分「没下发」')
  assert.ok(源.includes('不可能被调用'), '输出里要说清这不算问题')
  assert.ok(源.includes('白名单工具'), '要读 工具用量.json 里的白名单')
})

test('E6 工具用量.json 里带了白名单本身（体检靠它分流）', () => {
  const 根 = 造沙盒({ 会话们: { 'session-a': [行(现在 - 1000, 'qq_send')] }, 白名单: ['qq_send', 'qq_card'] })
  try {
    const d = JSON.parse(跑(根).出)
    assert.deepEqual(d.白名单工具.sort(), ['qq_card', 'qq_send'])
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('F1 系统字符要数到不带 type 的块（soul/state/预查都是这种，原来一个字都不计）', async () => {
  const m = await import(join(TOOLS, 'usage-解析.mjs'))
  const 观测 = (system) => m.请求观测({ system, messages: [], tools: [] }).系统字符
  assert.equal(观测([{ type: 'text', text: 'base' }, { text: '啊'.repeat(1864) }]), 1868,
    '不带 type 的 text 块没被数进去 —— SOUL 就是这么拼进 system 的')
  assert.equal(观测([{ content: '一二' }]), 2, 'content 字段的块也要数')
  assert.equal(观测('一二三四五'), 5, '纯字符串形态')
  assert.equal(观测([{ type: 'image' }]), 0, '图片块没有文字，不该贡献字数')
})

test('F2 心跳表里的「工具用量」任务调度：:17 命中、:18 不命中', () => {
  const 表 = JSON.parse(readFileSync(join(TOOLS, '心跳表.json'), 'utf8'))['任务'] || []
  const t = 表.find((x) => x['脚本'] === '工具用量.mjs')
  assert.ok(t, '心跳表里没有 工具用量.mjs')
  assert.equal(t['间隔分'], 60)
  assert.equal(t['偏移分'], 17)
  assert.ok((t['参数'] || []).includes('--静'), '心跳跑必须 --静，否则每分钟日志噪音')
})
