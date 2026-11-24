// t363.test.mjs —— 一起听「此刻音乐」的合并判据（批次363）
//
// 为什么要这个测试：2026-11-12 19:5x 主人连着报「切歌不同步」「都到下一首了听感还是前一首」
// 「时长严重不同步」。查出来是三件事叠在一起：
//   ① 音乐卡() 有两个喂法：/api/state 给英文键（name/active/progressSec），
//      /api/now 给中文键（歌名/正在播/进度秒），而函数只认英文 ——
//      换歌那一刻卡片被画成《undefined》＋「undefined 分钟前播完」，而且画完就不再重画；
//   ② 云端 playTime 在单曲循环时不刷新，按它往后推会涨过曲长（线上抓到 174 秒的曲推成 854 秒）；
//   ③ PC 上报器只有「第一次看到这个标题的时刻」，从中间开始听时推出来根本不对。
// ① 在前端 HTML 里，node 测不到；这里锁 ②③ 的服务端判据。抠的是线上 面板.mjs 的函数体本身，
// 所以改了实现就会红 —— 这是故意的：这几条判据是踩出来的，不是想出来的。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const 面板 = process.env.QQ_PANEL_SRC || '{{BOT_ROOT}}/共享/工具/面板.mjs'

async function 取此刻音乐() {
  const src = fs.readFileSync(面板, 'utf8')
  const a = src.indexOf('function 此刻音乐(是主人) {')
  const b = src.indexOf('function 读音乐账号()')
  assert.ok(a > 0 && b > a, '面板.mjs 结构变了：找不到 此刻音乐 / 读音乐账号 的边界')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't363-'))
  const head = [
    "import fs from 'node:fs'",
    `const base = ${JSON.stringify(dir)}`,
    "const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }",
    "const 读接入 = () => ({ '一起听': { 开启: true } })",
    "const 读音乐账号 = () => ({ 当前: 'test' })",
    'function 实时曲() {',
    '  try {',
    "    const r = load(base + '/一起听实时.json', null)",
    '    if (!r || !r.歌名) return null',
    '    const at = Number(r.at) || 0',
    '    if (Date.now() - at > 20000) return null',
    '    return r',
    '  } catch { return null }',
    '}',
    '',
  ].join('\n')
  const f = path.join(dir, 'nowmusic.mjs')
  fs.writeFileSync(f, head + src.slice(a, b) + '\nexport { 此刻音乐 }\n', 'utf8')
  return { 此刻音乐: (await import(pathToFileURL(f).href)).此刻音乐, dir }
}

const 写 = (d, n, o) => fs.writeFileSync(path.join(d, n), JSON.stringify(o), 'utf8')
const 清 = (d) => { try { fs.unlinkSync(path.join(d, '一起听实时.json')) } catch { /* 本来就没有 */ } }
// 只比这四项：其余字段（同步秒/年龄分/听感）跟这几条判据无关
const 取 = (o) => [o.正在播, o.歌名, o.进度秒, o.时长秒].join('|')

test('A 正常在播、没装上报器 → 走账号那份', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  清(dir)
  写(dir, '一起听.json', { active: true, name: '歌A', artist: '手A', progressSec: 60, durationSec: 200, playTime: now - 60000, checkedAt: now, replayCount: 1 })
  assert.equal(取(此刻音乐(true)), 'true|歌A|60|200')
})

test('B 上报器在推同一首 → 一律用上报器的进度，不再采信云端那份', async () => {
  // 这条在批次364 改过语义。原来是「同名就放宽窗口、用云端的 progressSec」；
  // 现在上报器读的是 PC 本地库（feeiyuu 的号），云端那份是另一个号（胧焯），
  // 同名只是巧合 —— 一律以上报器为准，云端只在上报器不在时兜底。
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  写(dir, '一起听实时.json', { 歌名: '歌B', at: now - 2000, since: now - 60000, durationSec: 174 })
  // 云端故意写成「循环到第二遍、progressSec=158」：旧逻辑会采信它，新逻辑不会
  写(dir, '一起听.json', { active: true, name: '歌B', artist: '手B', progressSec: 158, durationSec: 174, playTime: now - 854000, checkedAt: now, replayCount: 2 })
  assert.equal(取(此刻音乐(true)), 'true|歌B|60|174')
})

test('C 同一份数据、上报器死了 → 超窗就判已播完，不假装还在放', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  清(dir)
  写(dir, '一起听.json', { active: false, name: '歌B', artist: '手B', progressSec: 0, durationSec: 174, playTime: now - 854000, checkedAt: now })
  assert.equal(取(此刻音乐(true)), 'false|歌B|0|174')
})

test('D 上报器领先云端（云端还停在上一首）→ 以上报器为准', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  写(dir, '一起听实时.json', { 歌名: '新歌', at: now - 1000, since: now - 30000, durationSec: 210 })
  写(dir, '一起听.json', { active: true, name: '老歌', artist: '老手', progressSec: 100, durationSec: 180, playTime: now - 100000, checkedAt: now })
  assert.equal(取(此刻音乐(true)), 'true|新歌|30|210')
})

test('E 上报器推算已超曲长（从中间开始听 / 循环第几遍不知道）→ 进度留空，不许硬编一个数字', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  写(dir, '一起听实时.json', { 歌名: '新歌', at: now - 1000, since: now - 500000, durationSec: 210 })
  写(dir, '一起听.json', { active: true, name: '老歌', artist: '老手', progressSec: 100, durationSec: 180, playTime: now - 100000, checkedAt: now })
  assert.equal(取(此刻音乐(true)), 'true|新歌|0|210')
})

test('F 上报器推算还在第一遍内 → 正常给进度', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  写(dir, '一起听实时.json', { 歌名: '新歌', at: now - 1000, since: now - 45000, durationSec: 210 })
  assert.equal(取(此刻音乐(true)), 'true|新歌|45|210')
})

test('G 上报器档超过 20 秒没推（关机 / 关播放器）→ 当没装', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  写(dir, '一起听实时.json', { 歌名: '新歌', at: now - 40000, since: now - 45000, durationSec: 210 })
  写(dir, '一起听.json', { active: true, name: '老歌', artist: '老手', progressSec: 100, durationSec: 180, playTime: now - 100000, checkedAt: now })
  assert.equal(取(此刻音乐(true)), 'true|老歌|100|180')
})

test('H 一起听被关掉 → 直接返回关闭态（这条别被上面几个分支绕过去）', async () => {
  const src = fs.readFileSync(面板, 'utf8')
  const a = src.indexOf('function 此刻音乐(是主人) {')
  assert.ok(a > 0)
  // 关掉时不读任何档，所以把 base 指到一个空目录也必须出「关闭」
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't363off-'))
  const head = [
    "import fs from 'node:fs'",
    `const base = ${JSON.stringify(dir)}`,
    "const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }",
    "const 读接入 = () => ({ '一起听': { 开启: false } })",
    "const 读音乐账号 = () => ({ 当前: '' })",
    'function 实时曲() { return null }',
    '',
  ].join('\n')
  const b = src.indexOf('function 读音乐账号()')
  const f = path.join(dir, 'off.mjs')
  fs.writeFileSync(f, head + src.slice(a, b) + '\nexport { 此刻音乐 }\n', 'utf8')
  const { 此刻音乐 } = await import(pathToFileURL(f).href)
  const r = 此刻音乐(true)
  assert.equal(r.开启, false)
  assert.equal(r.正在播, false)
  assert.equal(r.歌名, '')
})


// ===== 前端卡片 =====
// 用户看到的是卡片，不是 此刻音乐 的返回值。这里抠 简洁页.html 里的 音乐卡(),
// 两种键形状各喂一次 —— 上一版的 bug 就是中文键喂进去画出《undefined》。
const 页面 = process.env.QQ_PAGE_SRC || '{{BOT_ROOT}}/共享/工具/简洁页.html'

async function 取音乐卡() {
  const src = fs.readFileSync(页面, 'utf8')
  const a = src.indexOf('function 音乐卡(mt0, 源) {')
  const b = src.indexOf('function mmss(x) {')
  const c = src.indexOf('function 新鲜字(秒) {')
  const d = src.indexOf('function 判在走(歌, 源) {')
  const e = src.indexOf('function 画音乐行(歌) {')
  assert.ok(a > 0 && b > a, '简洁页.html 结构变了：找不到 音乐卡 / mmss 的边界')
  assert.ok(c > b && d > c && e > d, '简洁页.html 结构变了：mmss / 新鲜字 / 判在走 / 画音乐行 顺序不对')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't363card-'))
  const parts = [
    'const dbgEsc = (t) => String(t == null ? "" : t)',
    src.slice(a, b),      // 音乐卡
    src.slice(b, c),      // mmss
    src.slice(c, d),      // 新鲜字
    src.slice(d, e),      // 判在走
    'export { 音乐卡, 判在走, mmss }',
  ]
  const f = path.join(dir, 'card.mjs')
  fs.writeFileSync(f, parts.join('\n'), 'utf8')
  return await import(pathToFileURL(f).href)
}

test('I 卡片：/api/state 那种英文键 → 歌名/歌手/进度/听感都在，且不许出现 undefined', async () => {
  const { 音乐卡 } = await 取音乐卡()
  const html = 音乐卡({ name: '歌A', artist: '手A', active: true, progressSec: 62, durationSec: 200, ageMin: 0, replayCount: 1, feel: '像下午的太阳' }, 'state')
  assert.ok(html.includes('歌A'), '歌名没渲染出来')
  assert.ok(html.includes('手A'), '歌手没渲染出来')
  assert.ok(html.includes('1:02'), '进度没渲染出来')
  assert.ok(html.includes('3:20'), '总时长没渲染出来')
  assert.ok(html.includes('像下午的太阳'), '听感没渲染出来')
  assert.ok(!html.includes('undefined'), '出现 undefined：' + html)
})

test('J 卡片：/api/now 那种中文键 → 同一张卡，同一个结果', async () => {
  const { 音乐卡 } = await 取音乐卡()
  const html = 音乐卡({ 歌名: '歌A', 歌手: '手A', 正在播: true, 进度秒: 62, 时长秒: 200, 年龄分: 0, 循环次数: 1, 听感: '像下午的太阳' }, 'state')
  assert.ok(html.includes('歌A'), '中文键喂进去歌名丢了')
  assert.ok(html.includes('1:02'), '中文键喂进去进度丢了')
  assert.ok(html.includes('像下午的太阳'), '中文键喂进去听感丢了')
  assert.ok(!html.includes('undefined'), '中文键喂进去出现 undefined：' + html)
})

test('K 卡片：换歌监听传空听感 → 卡上不许残留上一首的听感', async () => {
  const { 音乐卡 } = await 取音乐卡()
  // 这是主人报的「都到下一首了听感还是前一首」：唱歌切走时 feel 必须是空的
  const html = 音乐卡({ 歌名: '新歌', 歌手: '新手', 正在播: true, 进度秒: 0, 时长秒: 210, 年龄分: 0, 循环次数: 1, 听感: '', feel: '' }, 'state')
  assert.ok(html.includes('新歌'))
  assert.ok(!html.includes('听感'), '不该有听感那半句：' + html)
  assert.ok(!html.includes('undefined'))
})

test('L 卡片：暂停时进度条要停住，不显示成 0:00 往前跑', async () => {
  const { 音乐卡 } = await 取音乐卡()
  const html = 音乐卡({ name: '歌C', artist: '', active: false, progressSec: 0, durationSec: 180, ageMin: 12, replayCount: 1, feel: '' }, 'state')
  assert.ok(html.includes('刚才一起听过'), '暂停态标题不对：' + html)
  assert.ok(html.includes('12 分钟前播完'), '暂停态副标题不对：' + html)
  assert.ok(!html.includes('mtprog'), '暂停时不该有进度条')
})


test('M 上报器不在、云端那条超过 90 分钟 → 当作没在听（别把她挂在另一个号的歌上）', async () => {
  const { 此刻音乐, dir } = await 取此刻音乐()
  const now = Date.now()
  清(dir)
  写(dir, '一起听.json', { active: false, name: '别人的歌', artist: '别人', progressSec: 0, durationSec: 180, playTime: now - 3 * 3600e3, checkedAt: now })
  const r = 此刻音乐(true)
  assert.equal(r.开启, true)
  assert.equal(r.正在播, false)
  assert.equal(r.歌名, '')
})
