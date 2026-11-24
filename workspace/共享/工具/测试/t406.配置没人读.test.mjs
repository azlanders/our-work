// t406 —— 配置项 / 参数项「写了没人读」（批次397）
//
// 为什么测这些：主人这一轮点名要查「插件、系统没达到预期功能」。
// 上一批修的是「工具的调用账本漏了 30 种工具」，这一批是同一类病的另外两面：
//   · 桥配置（qq-bridge.config.json）里的键，改了会不会发生什么；
//   · 参数.json 里的阈值，面板上滑了会不会生效。
// 实测抓到的：
//   · `phoneOwnerAlways` 在配置里挂着，而 phone.mjs 里对应的豁免分支批次235 就删了 ——
//     改它什么都不会发生，但长得跟别的开关一模一样；
//   · 参数.json 里 14 个键（睡眠段整段、好感度的维度上限/事件加减、拟人的性格_基准和 7 个 睡眠_*）
//     全项目零引用 —— 谁改谁踩空，而且不报错。
//
// 这个文件锁四件事：
//   A 参数活段零死键 / 配置零死键（两个契约检查的判据，这里独立再跑一遍）
//   B 「有代码读」要认 lib/*.mjs（第一版契约只认 .js，把 贴表情_每小时上限 冤枉成死参数）
//   C 死键按项目约定搬进 _未接线（值保留，不是删掉）
//   D 贴表情上限在面板上看得见、改得动
//
// 跑法：node --test t406.配置没人读.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const DIR = '{{BOT_ROOT}}'
const TOOLS = join(DIR, '共享/工具')
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const CFG = '{{DSH_ROOT}}/qq-bridge.config.json'
const 参数路 = join(TOOLS, '参数.json')

const 读 = (p) => readFileSync(p, 'utf8')

/** 把「可能有代码读它」的源码都收进来：lib 的 .js 和 .mjs 都要，工具目录去掉契约检查自己。 */
function 源码们() {
  const 出 = []
  for (const f of readdirSync(LIB)) {
    if (!/\.(js|mjs)$/.test(f) || f.includes('.pre-')) continue
    出.push(读(join(LIB, f)))
  }
  for (const f of readdirSync(TOOLS)) {
    const p = join(TOOLS, f)
    if (!/\.(mjs|js)$/.test(f) || f === '契约检查.mjs') continue
    try { if (!statSync(p).isFile()) continue } catch { continue }
    出.push(读(p))
  }
  return 出
}

function 死参数() {
  const 参 = JSON.parse(读(参数路))
  const 全 = 源码们().join('\n')
  const 死 = []
  for (const [段, 表] of Object.entries(参)) {
    if (段.startsWith('_') || !表 || typeof 表 !== 'object' || Array.isArray(表)) continue
    for (const k of Object.keys(表)) {
      if (k.startsWith('_')) continue
      if (!全.includes(k)) 死.push(段 + '.' + k)
    }
  }
  return 死
}

test('A1 参数.json 的活段里没有「没人读」的键', () => {
  const 死 = 死参数()
  assert.deepEqual(死, [], '这些参数改了不会发生任何事：' + 死.join('、'))
})

test('A2 桥配置里没有「没人读」的键', () => {
  const 桥 = JSON.parse(读(CFG))
  const 全 = 源码们().join('\n')
  const 死 = Object.keys(桥).filter((k) => !全.includes(k))
  assert.deepEqual(死, [], '这些配置键改了不会发生任何事：' + 死.join('、'))
})

test('A3 phoneOwnerAlways 不许回来（它的代码分支批次235 就删了，留着就是骗人的开关）', () => {
  const 桥 = JSON.parse(读(CFG))
  assert.equal('phoneOwnerAlways' in 桥, false, '这个键没有任何代码读，别再加回配置')
  // 行为本身还在：主人跟群友一样要 @ 才叫得出来
  assert.ok(读(join(LIB, 'phone.mjs')).includes('主人不在豁免名单里'), 'phone.mjs 的判据说明被改了？')
})

test('B1 「有代码读」必须认 lib/*.mjs —— 第一版只认 .js，把 贴表情_每小时上限 冤枉成死参数', () => {
  const 贴 = 读(join(LIB, '贴表情.mjs'))
  assert.ok(贴.includes('贴表情_每小时上限'), '贴表情.mjs 里应该有这个键（动态取法 j?.拟人?.键）')
  const 死 = 死参数()
  assert.ok(!死.includes('拟人.贴表情_每小时上限'), '它其实有人读，不该被判死')
})

test('B2 扫描口径：lib 下的 .mjs 数量不能是 0（否则 B1 会假通过）', () => {
  const mjs = readdirSync(LIB).filter((f) => f.endsWith('.mjs') && !f.includes('.pre-'))
  assert.ok(mjs.length >= 5, 'lib 下 .mjs 应该有一批（贴表情/感受/睡态/睡眠阶段…），实际 ' + mjs.length)
})

test('C1 死键按项目约定搬进 _未接线，值要保留（不是删掉）', () => {
  const 参 = JSON.parse(读(参数路))
  assert.equal('睡眠' in 参, false, '睡眠段整段没人读，应该已经搬走')
  const u = 参['_未接线']
  assert.ok(u && typeof u === 'object', '缺 _未接线 段')
  assert.equal(u['睡眠']['满分小时'], 8, '_未接线 里要留着值，别只剩名字')
  assert.equal(u['睡眠']['每少一小时扣分'], 12)
  assert.equal(u['拟人']['性格_基准'], 0.75)
  assert.ok(u['好感度']['维度上限'] && typeof u['好感度']['维度上限'] === 'object', '好感度的对象值也要留着')
})

test('C2 好感度活段还剩能用的一半（单次封顶 / 最低分 有代码读，不能一起搬走）', () => {
  const 参 = JSON.parse(读(参数路))
  assert.ok(参['好感度'] && typeof 参['好感度'] === 'object', '好感度段不该整个消失')
  assert.ok('单次封顶' in 参['好感度'], '单次封顶 有人读，搬走就断了')
})

test('D1 面板有「贴表情」一屏，并且暴露了上限滑块', () => {
  const 源 = 读(join(TOOLS, '面板.mjs'))
  assert.ok(源.includes("g('react', '贴表情'"), '缺 贴表情 分组')
  assert.ok(源.includes("id: 'react.' + 键"), '缺 react 组的可调项映射')
  assert.ok(源.includes('贴表情_每小时上限'), '上限没接进面板')
})

test('D2 参数.json 里这个上限还在（值 0 = 不限，是当前状态，不是 bug）', () => {
  const 参 = JSON.parse(读(参数路))
  assert.equal(typeof 参['拟人']['贴表情_每小时上限'], 'number')
})

test('E1 qq_sleep 的 why 接上了（原来声明了但 execute 一次没读，填了等于没填）', () => {
  const 源 = readFileSync(join(LIB, 'sleep.js'), 'utf8')
  assert.ok(源.includes('args?.why'), 'execute 里没读 why')
  assert.ok(/opt\.why|opt && opt\.why/.test(源), '眯一会儿 没把 why 往下传')
  assert.ok(源.includes('const 因 ='), '缺「因」这个中间变量（原来写死了「自己觉得困」）')
})

test('E2 契约里那条「工具参数都有人在读」在，而且整份契约是绿的', () => {
  const 源 = readFileSync(join(TOOLS, '契约检查.mjs'), 'utf8')
  assert.ok(源.includes('工具参数都有人在读'), '缺第 22 条检查')
  const out = execFileSync(process.execPath, [join(TOOLS, '契约检查.mjs')], { encoding: 'utf8', timeout: 120e3 })
  assert.match(out, /0 项不对/, '契约检查没全绿：' + out.slice(-400))
})

test('F1 人味：除「说明」「自省」外每一类都接进了注入', () => {
  const 人味 = JSON.parse(readFileSync(join(DIR, '记忆/人味.json'), 'utf8'))
  const poll源 = readFileSync(join(LIB, 'poll.js'), 'utf8')
  // SELF_NOTE 2026-11-24：`自省` 一直在 人味.json 里，但它自带用法标注
  // 「不每轮注入，写自述时才翻」—— 所以它不是「没接」，是**按设计不接**。
  // 旧断言写 `assert.deepEqual(没接, [])` 并注释说「批次422 把自省删了」，
  // 而事实是它没被删。红的不是代码，是断言与数据的认知不一致。
  // 现在按真实约定判断：说明=元信息，自省=显式标注不注入。
  const 不注入的 = new Set(['说明', '自省'])
  const 类别 = Object.keys(人味).filter((k) => !不注入的.has(k))
  const 没接 = 类别.filter((k) => !poll源.includes("'" + k + "'"))
  assert.deepEqual(没接, [], '还有没接的类别，实际：' + 没接.join('、'))
  // 自省 若哪天被真的接进每轮注入，这里要亮红 —— 那违反它自己写的用法
  assert.ok(人味['自省'], '自省 这一节不见了；它被删的话要同步这条断言')
  assert.ok(/不每轮注入/.test(String(人味['自省']['用法'] || '')),
    '自省的「用法」必须仍写着「不每轮注入」，否则下面那条豁免就不成立')
  assert.ok(poll源.includes("rw['约定与时间']"), '约定与时间 没接进 stateHintOf')
  assert.ok(人味['说明'].includes('八类'), '说明里要写明这是八类人味')
})

test('F4 约定与时间只接「能自判的一条」，不是四句全塞', () => {
  const 源 = readFileSync(join(LIB, 'poll.js'), 'utf8')
  // TIMELINE_DROP 2026-11-24：旧断言要求「久别 >= 12 / 钟点 <= 5 / 久别 < 0.5 /
  // 分钟 < 10」四条全在源码里。事实变了：
  //   · 2026-11-18 起「来信间隔由 deliver 按当前收件人的原始消息时间提供」，
  //     poll.js 不再读主动搭话账推断「久别」—— 久别那三个条件随之整段撤掉；
  //   · 2026-11-23 补上「约定与时间」这一类时，注释写明
  //     「只接能自判的一条：按北京时间钟点判断深夜；久别/纪念日需要收件人时间线，没接」。
  // 所以现在真实契约是：**只按钟点判深夜**，且条件与 人味.json 的措辞一致。
  // 断言改成锁这个真实契约，而不是锁一段已经不存在的代码。
  assert.ok(/const 钟 = new Date\(Date\.now\(\) \+ 8 \* 3600e3\)\.getUTCHours\(\)/.test(源),
    '缺「按北京时间取钟点」—— 深夜判据必须用北京时间，不能用服务器 UTC')
  assert.ok(/钟 >= 23 \|\| 钟 < 5/.test(源), '缺深夜判据（23 点后 / 5 点前）')
  assert.ok(/约 && 约\['深夜'\]/.test(源), '深夜 那句得从 人味.json 的 约定与时间.深夜 取，不许在代码里另写一遍')
  assert.ok(源.includes("人味："), '取到了却没拼进正文')
  // 反回归：久别 那套条件已撤，别又被搬回来 —— 搬回来会重新依赖收件人时间线
  assert.ok(!/久别 >= 12/.test(源), '久别 判据已撤（信件间隔由 deliver 提供），不该回到 poll.js')
})

test('F2 想要.json 标了接入情况：活段 5 段（422 接上独处的时候在想）', () => {
  const 想 = JSON.parse(readFileSync(join(DIR, '记忆/想要.json'), 'utf8'))
  const 情况 = 想['_接入情况']
  assert.ok(情况, '缺 _接入情况（下一批又会有人以为那些段是活的）')
  // 集合比较：两边都排一遍，别赌中文的排序规则
  assert.deepEqual(
    [...情况['活段（有代码读）']].sort(),
    ['当下想要', '满足的', '怕的', '纪念日', '独处的时候在想'].sort(),
    '活段应该正好是这五段',
  )
  // 批次422：`想约的/对未来的想象/第一次/承诺` 四段删了（全仓 0 处读），
  // 「没接的段」从一个数组变成一句「删掉了哪几段、为什么」。
  const 删了 = String(情况['删掉的段'] || '')
  for (const k of ['想约的', '对未来的想象', '第一次', '承诺']) {
    assert.ok(删了.includes(k), '「' + k + '」删了就得写进「删掉的段」，否则下一个人又以为它在')
  }
})

test('F3 契约第 23 条在（人味每一类都要接进注入）', () => {
  const 源 = readFileSync(join(TOOLS, '契约检查.mjs'), 'utf8')
  assert.ok(源.includes('人味每一类都接进了注入'), '缺第 23 条')
  assert.ok(源.includes('已知没接'), '缺台账（否则那两类会让契约永远红）')
})

// ── 纪念日（批次401 → 2026-11-24 迁 API）─────────────────────────
// 想要.json 的「纪念日」里躺着两条真数据（2026-10-30 第一次被搭起来 / 2026-11-01 第一次叫主人），
// 从写进去那天起没有代码读，她一次都没想起来过。这几条锁住接法。
//
// ANNIV_MOVED 2026-11-24：实现已从 `poll.js 纪念日段()` 搬到
// `记忆入口.mjs 纪念日条()/记纪念日已提示()`，由 `deliver.js` 投递时调用。
// 旧断言还在找 poll.js 的导出 → 四条全红。红的不是代码，是断言。
//
// 签名（读 记忆核心.mjs 确认过，别猜）：
//   纪念日条(target, config, sessionId, now, mem)
//   target = { kind: 'private', id: '<ownerUin>' }
//   config 必须满足 主人专属会话() 的三条：
//     ① 生活记忆角色(target, config) === 'owner'  → config.ownerUin === target.id
//     ② config.routes.private[id].sessionId 存在
//     ③ config.fallbackToLiveSession === false（否则一律判空）
//     ④ 会话路由(sessionId, config).length === 1
//   缺任何一条都返回 null —— 这正是「只在主人私聊里出现」的实现方式。

const 造主配置 = (uin, sid) => ({
  ownerUin: uin,
  fallbackToLiveSession: false,
  routes: { private: { [uin]: { sessionId: sid } } },
})

test('G1 纪念日条：只按「月-日」匹配（年份不管），非当天返回 null', async () => {
  const m = await import(join(LIB, '记忆入口.mjs'))
  const 根 = mkdtempSync(join(tmpdir(), 'anniv-'))
  try {
    writeFileSync(join(根, '想要.json'), JSON.stringify({
      纪念日: [{ day: '2026-10-30', 什么: '第一次被搭起来' }],
    }), 'utf8')
    const 北京 = (y, mo, d) => Date.UTC(y, mo - 1, d, 4)   // 12:00 北京
    const 主 = '{{OWNER_UIN}}'
    const 会话 = 'priv-' + 主
    const 目标 = { kind: 'private', id: 主 }
    const 配置 = 造主配置(主, 会话)
    const 条 = m.纪念日条(目标, 配置, 会话, 北京(2026, 10, 30), 根)
    assert.ok(条, '当天必须有（配置是主人私聊、路由唯一）')
    assert.equal(条.text, '[纪念日] 10-30：第一次被搭起来')
    assert.equal(m.纪念日条(目标, 配置, 会话, 北京(2026, 11, 14), 根), null, '不是这天不该说话')
    const 明年 = m.纪念日条(目标, 配置, 会话, 北京(2027, 10, 30), 根)
    assert.match(明年.text, /（第 1 年）$/, '只看月日不看年 —— 明年这天还得想起来')
    const 后年 = m.纪念日条(目标, 配置, 会话, 北京(2028, 10, 30), 根)
    assert.match(后年.text, /（第 2 年）$/)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('G2 纪念日一天只提一次，且不会把自己永久锁死（存完整日期，不是月日）', async () => {
  const m = await import(join(LIB, '记忆入口.mjs'))
  const 根 = mkdtempSync(join(tmpdir(), 'anniv-'))
  try {
    writeFileSync(join(根, '想要.json'), JSON.stringify({
      纪念日: [{ day: '2026-10-30', 什么: '第一次被搭起来' }],
    }), 'utf8')
    const 北京 = (y, mo, d) => Date.UTC(y, mo - 1, d, 4)
    const 主 = '{{OWNER_UIN}}'
    const 会话 = 'priv-' + 主
    const 目标 = { kind: 'private', id: 主 }
    const 配置 = 造主配置(主, 会话)
    const 首次 = m.纪念日条(目标, 配置, 会话, 北京(2026, 10, 30), 根)
    assert.ok(首次, '当天第一次必须提')
    m.记纪念日已提示(首次)              // 走真写盘，才能验回执格式
    assert.equal(m.纪念日条(目标, 配置, 会话, 北京(2026, 10, 30), 根), null, '同一天第二次不该再念')
    const 记 = JSON.parse(readFileSync(join(根, '纪念日提过.json'), 'utf8'))
    assert.equal(记['上次'], '2026-10-30',
      '存的必须是完整日期 —— 只存 MM-DD 的话，第一次写过就永久锁死，明年不会再提')
    const 明年 = m.纪念日条(目标, 配置, 会话, 北京(2027, 10, 30), 根)
    assert.match(明年.text, /（第 1 年）/, '明年同一天必须还能提')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('G3 纪念日只在主人私聊触达（判断在 纪念日条 内部，不靠调用方自觉）', () => {
  const 入 = readFileSync(join(LIB, '记忆入口.mjs'), 'utf8')
  assert.ok(/export function 纪念日条\(/.test(入), '纪念日条 得是导出的，否则没法单独测')
  assert.ok(/export function 记纪念日已提示\(/.test(入), '记纪念日已提示 得是导出的')
  assert.ok(/主人专属会话\(target, config\) !== sessionId/.test(入),
    'ownerPrivate 判断必须在函数内部 —— 放外面漏一次就流到群里')
  const 投 = readFileSync(join(LIB, 'deliver.js'), 'utf8')
  assert.ok(/纪念日条\(target, config, sessionId\)/.test(投), 'deliver.js 没调它 —— 等于没接线')
  assert.ok(/记纪念日已提示\(纪念日\)/.test(投), '取到了却没落回执 —— 会每轮重复念')
})

test('G4 纪念日读的是 想要.json，没了就闭嘴（不许抛错）', async () => {
  const m = await import(join(LIB, '记忆入口.mjs'))
  const 主 = '{{OWNER_UIN}}'
  const 会话 = 'priv-' + 主
  const 目标 = { kind: 'private', id: 主 }
  const 配置 = 造主配置(主, 会话)
  assert.equal(m.纪念日条(目标, 配置, 会话, Date.now(), '/tmp/没有这个目录-401'), null)
  assert.equal(m.纪念日条(目标, 配置, 会话, NaN, '/tmp/没有这个目录-401'), null)
  assert.equal(m.纪念日条(目标, 配置, '', Date.now(), '/tmp/没有这个目录-401'), null)
  // 群聊必须不触达
  const 群目标 = { kind: 'group', id: '1051483012' }
  const 群配置 = { ownerUin: 主, fallbackToLiveSession: false, routes: { group: { '1051483012': { sessionId: 会话 } } } }
  assert.equal(m.纪念日条(群目标, 群配置, 会话, Date.now(), '/tmp/没有这个目录-401'), null, '群聊不该有纪念日')
})
