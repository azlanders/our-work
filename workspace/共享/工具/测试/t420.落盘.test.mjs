// t420 —— 写操作真的写进文件了（批次416）
//
// 为什么要有：批次414 发现 `自改.mjs --set` 是个空壳 —— 改了内存、报告「改了」、
// 然后两条 return 前面没有 save()，从写下来那天起文件一个字没动。
// 批次415 做了一次落盘普查：12 个写脚本、11 个正常。
//
// 但那次是手工的，没留住。这批把它变成**回归测试**：每次改完代码，全套一跑就知道
// 谁又把写操作改成空壳了。
//
// 判据是确定性的：**沙盒里跑一次，目标文件的 md5 必须变。**
// 不像「体检」那样有「没变可能是正常拒绝」的歧义 —— 这里的前置是测试自己造的，
// 它只可能在「该写却没写」时失败。
//
// 跑法：node --test t420.落盘.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 沙 = mkdtempSync(join(tmpdir(), 'land420-'))
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

/** 造一个「什么都正常」的沙盒：醒着、在家、有点饿、身上没穿、没在洗澡 */
function 造() {
  rmSync(沙, { recursive: true, force: true })
  mkdirSync(join(沙, 'lock'), { recursive: true })
  // 先把真实的 80 个 json 全部搬过来 —— 表类数据（衣物表/物品总表/地图/商店）
  // 造不出来，缺了它们脚本会直接说「表里没有这件衣服」而不写盘。
  // 复制不会改真实目录（W7 专门验这一点）。
  const 真 = '{{BOT_ROOT}}/记忆'
  for (const f of readdirSync(真)) {
    if (f.endsWith('.json')) copyFileSync(join(真, f), join(沙, f))
  }
  const now = Date.now()
  const w = (f, o) => writeFileSync(join(沙, f), JSON.stringify(o))
  w('资产.json', { 钱: 100, 位置: '家', 记录: [] })
  w('自主.json', { state: '待命', since: now - 3600e3, nextAt: 0, log: [] })
  w('睡眠.json', { sleeping: false, last_sleep: { end: 北京(now - 6 * 3600e3) }, records: [] })
  w('睡醒.json', { sleeping: false, since: 北京(now - 6 * 3600e3) })
  w('卫生.json', { 清洁: 45, 上次洗: 北京(now - 40 * 3600e3), 次数: 1, 上次更新: 北京(now - 40 * 3600e3) })
  w('饱渴.json', { 血糖: 5, 血At: 北京(now), 水: 800, 水At: 北京(now), 卡: 600, 卡At: 北京(now), 胃: 200, 胃At: 北京(now), 欠: 0, 欠At: 北京(now), 账: [] })
  w('饥饿.json', { 饱腹: 30, 临时: 0, 最后吃At: 北京(now - 4 * 3600e3), 最后吃了: '早饭', 今天: { 日期: 北京(now).slice(0, 10), 顿: 1, 钱: 20, 零食: 0 }, 账: [] })
  w('偏好.json', { 说明: 'x', 喜欢: ['听雨声'], 讨厌: [] })
  w('自改日志.json', { items: [] })
  w('物品.json', { items: [] })
  w('天气.json', {})
  w('吃饭.json', {})
  w('打盹.json', {})
  // 身上是空的 —— 这样 --加 一件一定得写盘（原来写 穿衣.json 是错的，
  // 穿衣.mjs 的 穿P 是 穿着.json）
  w('穿着.json', { 部位: { 头: [], 脖子: [], 上臂: [], 下臂: [], 手: [], 上身: [], 下身: [], 大腿: [], 小腿: [], 脚: [] } })
}

function 跑(脚本, args, 额外 = {}) {
  try {
    return { code: 0, out: String(execFileSync(process.execPath, [join(TOOLS, 脚本), ...args], {
      encoding: 'utf8', timeout: 25000, cwd: TOOLS,
      env: {
        ...process.env, QQ_AUTONOMY_MEM: 沙, QQ_MEM: 沙, HUNGER_MEM: 沙, GAP_MEM: 沙,
        QQ_ACT_MEM: 沙, ST_BASE: 沙, CLOTH_MEM: 沙, NAP_MEM: 沙, SELF_MEM: 沙,
        BAOKE_MEM: 沙, STATUS_BASE: 沙, QQ_LOCK_DIR: join(沙, 'lock'), NODE_OPTIONS: '',
        QQ_YUAN_MEM: 沙, // 批次428：怨.mjs 自己一个变量名，跟 QQ_AUTONOMY_MEM 不是一回事
        ...额外,
      },
    })).trim() }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

function md5(f) {
  try { return createHash('md5').update(readFileSync(join(沙, f))).digest('hex') } catch { return '（没有这个文件）' }
}

/**
 * 跑一次，断言这几个文件**每一个**都变了。
 *
 * 第一版写的是「至少有一个变」—— 反测时把 `自改.mjs` 的 `save(fp, db)` 删掉（退回批次414
 * 那个空壳）它居然还是绿的：因为 `自改日志.json` 由 `noteIt()` 单独写，照样会变，
 * 「至少一个」就被它满足了。**多个文件并列时，「至少一个」等于什么都没断言。**
 */
function 必须写盘(名, 脚本, args, 该变的, 准备, 额外) {
  test(名, () => {
    造()
    if (准备) 准备()
    const 前 = Object.fromEntries(该变的.map((f) => [f, md5(f)]))
    const r = 跑(脚本, args, 额外)
    assert.equal(r.code, 0, 脚本 + ' 跑失败了：' + r.out.slice(0, 300))
    const 没变 = 该变的.filter((f) => md5(f) === 前[f])
    assert.deepEqual(没变, [],
      '报告「' + r.out.split('\n')[0].slice(0, 80) + '」，但这些文件一个字没动：' + 没变.join('、'))
  })
}

必须写盘('W1 饱渴 --喝 500 毫升 → 饱渴.json 变', '饱渴.mjs', ['--喝', '500'], ['饱渴.json'])

必须写盘('W2 打盹 --开始 20 → 打盹.json 变', '打盹.mjs', ['--开始', '20'], ['打盹.json'])

必须写盘('W3 资产 --去 街市 → 资产.json 变', '资产.mjs', ['--去', '街市'], ['资产.json'])

必须写盘('W4 洗澡 --开始 → 卫生.json 变', '洗澡.mjs', ['--开始'], ['卫生.json'])

必须写盘('W5 自改 --set 偏好.喜欢 → 偏好.json + 日志都变', '自改.mjs',
  ['--set', '偏好.喜欢', '--value', '写盘测试用一条'], ['偏好.json', '自改日志.json'])

必须写盘('W6 穿衣 --加 白裙子 → 穿着.json 变（沙盒里身上是空的）', '穿衣.mjs',
  ['--加', '白裙子'], ['穿着.json'])

// ── 批次428：补齐原来说「未进」的四个写操作 ──
// 这四个之前没进，原因各不相同：物品要先把伞放在家里、怨要有人可怨、同步表**根本没法沙盒**
// （TOOLS 硬编码，一测就写真档 —— 见 同步表.mjs 顶部 CART_SANDBOX）。疾病最简单，只是漏了。

必须写盘('W8 物品 --拿 雨伞 → 物品.json 变（伞在家、人在家）', '物品.mjs', ['--拿', '雨伞'], ['物品.json'],
  () => writeFileSync(join(沙, '物品.json'), JSON.stringify({ items: [{ n: '雨伞', 在: '家', 来: '买', 于: '2026-11-10 10:00' }], 建: '2026-11-05 16:23' })))

必须写盘('W9 疾病 --判 --force → 疾病.json 变（--force 必中）', '疾病.mjs', ['--判', '--force'], ['疾病.json'])

必须写盘('W10 怨 --tick → 怨.json 变（有人可怨，at 是昨天）', '怨.mjs', ['--tick'], ['怨.json'],
  () => writeFileSync(join(沙, '怨.json'), JSON.stringify({ people: { '10001': { level: 40, at: 北京(Date.now() - 3 * 864e5), familiar: 5 } } })))

test('W11 同步表 --写 → 商店表与地图都被反算纠正，真表一个字没动', () => {
  // 砂：把 商店-生活.json 里「早饭」的售卖点清空，总表里它是有售卖点的 ——
  // 这正是这个脚本存在的理由（三处手写已经分歧过），也给了「必须变」一个确定的前提。
  造()
  const 工具沙 = join(沙, '工具')
  mkdirSync(工具沙, { recursive: true })
  const 真店P = join(TOOLS, '商店-生活.json')
  const 真图P = join(TOOLS, '地图.json')
  const 店 = JSON.parse(readFileSync(真店P, 'utf8'))
  // 优先「早饭」——它是总表 物品总表.json 里确实有、且售卖点非空的条目（反算才有东西可写）
  const 候选 = Object.keys(店.商品 || {}).filter((k) => Array.isArray(店.商品[k].售卖点) && 店.商品[k].售卖点.length > 0)
  const 键 = 候选.includes('早饭') ? '早饭' : 候选[0]
  assert.ok(键, '商店表里找不到任何带售卖点的商品，这条测试失去前提')
  店.商品[键].售卖点 = []
  writeFileSync(join(工具沙, '商店-生活.json'), JSON.stringify(店))
  // 地图也要造差异 —— `--写` 只写「有变化」的那张（源码按 改.xxx.length 判）。
  // 真档的地图本来就一致，不清空的话它根本不会被写，断言「地图必须变」就是假红。
  const 图 = JSON.parse(readFileSync(真图P, 'utf8'))
  const 地 = Object.keys(图.地点 || {}).find((k) => Array.isArray(图.地点[k].服务) && 图.地点[k].服务.length > 0)
  assert.ok(地, '地图里找不到任何有服务的地点，这条测试失去前提')
  图.地点[地].服务 = []
  writeFileSync(join(工具沙, '地图.json'), JSON.stringify(图))

  const 真店前 = createHash('md5').update(readFileSync(真店P)).digest('hex')
  const 真图前 = createHash('md5').update(readFileSync(真图P)).digest('hex')

  const r = 跑('同步表.mjs', ['--写'], { QQ_TOOLS: 工具沙 })
  assert.equal(r.code, 0, '跑失败了：' + r.out.slice(0, 300))

  const 后 = JSON.parse(readFileSync(join(工具沙, '商店-生活.json'), 'utf8'))
  assert.ok(后.商品[键].售卖点.length > 0, '「' + 键 + '」的售卖点没被反算回来')
  const 后图 = JSON.parse(readFileSync(join(工具沙, '地图.json'), 'utf8'))
  assert.ok((后图.地点[地].服务 || []).length > 0, '「' + 地 + '」的服务没被反算回来')
  assert.equal(createHash('md5').update(readFileSync(真店P)).digest('hex'), 真店前, '真商店表被写了！')
  assert.equal(createHash('md5').update(readFileSync(真图P)).digest('hex'), 真图前, '真地图被写了！')
})


test('W7 真实记忆目录没被碰（沙盒变量盖住了）', () => {
  // 注意：不能假设这些文件一定存在 —— 二号机静音两周，`偏好.json` 根本没有，
  // 第一版直接 readFileSync 就抛 ENOENT 了。文件不存在时按「空指纹」处理。
  const 真 = '{{BOT_ROOT}}/记忆/'
  const 取 = (f) => { try { return createHash('md5').update(readFileSync(真 + f)).digest('hex') } catch { return '（没有这个文件）' } }
  const 档们 = ['资产.json', '偏好.json', '饱渴.json', '卫生.json', '打盹.json']
  const 前 = Object.fromEntries(档们.map((f) => [f, 取(f)]))
  造()
  跑('饱渴.mjs', ['--喝', '500'])
  跑('自改.mjs', ['--set', '偏好.喜欢', '--value', '不该出现在真档里'])
  for (const f of 档们) {
    assert.equal(取(f), 前[f], '真实 ' + f + ' 被测试改了')
  }
  let 真偏 = ''
  try { 真偏 = readFileSync(真 + '偏好.json', 'utf8') } catch { /* 没有就没有 */ }
  assert.ok(!真偏.includes('不该出现在真档里'), '测试内容写进了真实 偏好.json')
})
