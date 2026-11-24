// t419 —— 「她饿不饿」只能有一个判据（批次415）
//
// 为什么要有：`饥饿.json.饱腹` 原来是个**死字段** —— `吃()` 存盘时 `out` 里没有它，
// `...记账` 带的是旧值，于是它停在一个历史数字（实测线上恒为 55），而 `读()` 现算是 98。
// 而三处（自动作息:341 / 醒来:119 / 状态推进:232）各自 `load('饥饿.json').饱腹 <= 10`
// 判「饿不饿」—— 输入是常数，等于从来没生效过。
//
// 这个文件锁：
//   H1 饿着() 问的是现算值，不是文件字段（两个沙盒同一个文件字段、不同饱渴数据，结果必须不同）
//   H2 吃() 存盘时把 饱腹 写对（不再留死字段）
//   H3 三处判据都改成问 饥饿.饿着()，且没有任何一处还在直接读文件字段
//   H4 醒来.mjs 不再硬编码记忆路径
//
// 跑法：node --test t419.饿判据.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 沙 = mkdtempSync(join(tmpdir(), 'hunger419-'))

const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

/** 造一个只关心「饱不饱」的沙盒：饥饿.json 里的 饱腹 由参数决定，饱渴.json 由卡数决定 */
function 造(名, { 文件饱腹, 卡 }) {
  const d = join(沙, 名)
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true })
  const now = Date.now()
  writeFileSync(join(d, '饥饿.json'), JSON.stringify({
    饱腹: 文件饱腹, 临时: 0, 最后吃At: 北京(now - 3 * 3600e3), 最后吃了: '早饭',
    今天: { 日期: 北京(now).slice(0, 10), 顿: 2, 钱: 30, 零食: 0 }, 账: [],
  }))
  writeFileSync(join(d, '饱渴.json'), JSON.stringify({
    血糖: 5.0, 血At: 北京(now), 水: 1500, 水At: 北京(now),
    卡, 卡At: 北京(now), 胃: 300, 胃At: 北京(now), 欠: 0, 欠At: 北京(now), 账: [],
  }))
  return d
}

function 跑(脚本, args, dir) {
  try {
    return { code: 0, out: String(execFileSync(process.execPath, [join(TOOLS, 脚本), ...args], {
      encoding: 'utf8', timeout: 25000, cwd: TOOLS,
      env: {
        ...process.env, QQ_AUTONOMY_MEM: dir, HUNGER_MEM: dir, GAP_MEM: dir, QQ_ACT_MEM: dir,
        ST_BASE: dir, QQ_LOCK_DIR: join(dir, 'lock'), NODE_OPTIONS: '',
      },
    })).trim() }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

test('H1 饿着() 问的是现算值，不是文件里那个死字段', async () => {
  // 注意：不能靠「换目录 + 换查询串重新 import」来测 —— `饥饿.mjs` 重新加载了，
  // 但它 `import * as 饱渴 from './饱渴.mjs'` 走的是模块缓存，`饱渴` 的 MEM
  // 还定在第一次那个目录。所以同一个沙盒里改 饱渴.json 的内容才是干净的测法。
  //
  // 关键设计：`饥饿.json.饱腹` **从头到尾都是 0**（文件说「饿得发慌」）。
  // 饱渴写满卡时 `饿着()` 必须给 false，写空卡时必须给 true —— 同一个文件字段
  // 给出两个答案，只可能是它在看现算值。
  const d = 造('同一个', { 文件饱腹: 0, 卡: 2000 })
  process.env.HUNGER_MEM = d
  const 饥 = await import(join(TOOLS, '饥饿.mjs') + '?h1=' + Date.now())

  const 饱答案 = 饥.饿着(10)
  const 饱真值 = 饥.读().饱腹
  assert.equal(饱答案, false, '文件写 0、但饱渴满卡（现算 ' + 饱真值 + '）→ 不该判她饿着')

  // 同一个目录，只把饱渴换成空卡
  const now = Date.now()
  writeFileSync(join(d, '饱渴.json'), JSON.stringify({
    血糖: 5.0, 血At: 北京(now), 水: 1500, 水At: 北京(now),
    卡: 0, 卡At: 北京(now), 胃: 0, 胃At: 北京(now), 欠: 0, 欠At: 北京(now), 账: [],
  }))
  const 饿答案 = 饥.饿着(10)
  const 饿真值 = 饥.读().饱腹
  assert.equal(饿答案, true, '文件写 0、饱渴空卡（现算 ' + 饿真值 + '）→ 该判她饿着')

  assert.equal(JSON.parse(readFileSync(join(d, '饥饿.json'), 'utf8')).饱腹, 0, '文件字段被测试改了，这条就不成立了')
  assert.notEqual(饱答案, 饿答案, '同一个文件字段给出同一答案 —— 说明读的还是那个常数')
})

test('H2 吃() 存盘时把 饱腹 写对（不留死字段）', async () => {
  const d = 造('吃', { 文件饱腹: 7, 卡: 400 })
  const r = 跑('饥饿.mjs', ['--吃', '早饭'], d)
  assert.equal(r.code, 0, r.out)
  const 档 = JSON.parse(readFileSync(join(d, '饥饿.json'), 'utf8'))
  assert.notEqual(Number(档.饱腹), 7, '吃完了，存盘的 饱腹 还是旧值 7 —— 死字段没修好')
  assert.ok(Number(档.饱腹) > 0, '存盘的 饱腹 是 ' + 档.饱腹)
})

test('H3 三处判据都问 饥饿.饿着()，没有一处还在直接读文件字段', () => {
  const 三 = {
    自动作息: readFileSync(join(TOOLS, '自动作息.mjs'), 'utf8'),
    醒来: readFileSync(join(TOOLS, '醒来.mjs'), 'utf8'),
    状态推进: readFileSync(join(TOOLS, '状态推进.mjs'), 'utf8'),
  }
  for (const [名, txt] of Object.entries(三)) {
    assert.match(txt, /饥饿\.饿着\(/, 名 + ' 没调 饥饿.饿着()')
    assert.match(txt, /import \* as 饥饿 from '\.\/饥饿\.mjs'/, 名 + ' 没 import 饥饿')
    // 判据里不许再出现「读 饥饿.json 的饱腹」—— 注释里可以提，代码里不行
    const 代码行 = txt.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    const 残留 = 代码行.filter((l) => /饥饿\.json/.test(l) && /饱腹/.test(l))
    assert.equal(残留.length, 0, 名 + ' 还在直接读文件字段：\n' + 残留.join('\n'))
  }
})

test('H4 醒来.mjs 不再硬编码记忆路径', () => {
  const txt = readFileSync(join(TOOLS, '醒来.mjs'), 'utf8')
  const 代码行 = txt.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  const 硬 = 代码行.filter((l) => l.includes("'{{BOT_ROOT}}/记忆/饥饿.json'"))
  assert.equal(硬.length, 0, '还在硬编码路径：\n' + 硬.join('\n'))
})

test('H5 三个脚本还能正常跑（改判据没把它们改崩）', () => {
  const d = 造('跑', { 文件饱腹: 55, 卡: 1900 })
  mkdirSync(join(d, 'lock'), { recursive: true })
  const a = 跑('状态推进.mjs', ['--force'], d)
  assert.equal(a.code, 0, '状态推进 崩了：' + a.out.slice(0, 300))
  const b = 跑('醒来.mjs', [], d)
  assert.equal(b.code, 0, '醒来 崩了：' + b.out.slice(0, 300))
})

test('H6 单测不碰真实的 饥饿.json', () => {
  const 真 = '{{BOT_ROOT}}/记忆/饥饿.json'
  const 前 = existsSync(真) ? readFileSync(真, 'utf8') : ''
  造('干净检查', { 文件饱腹: 1, 卡: 0 })
  const 后 = existsSync(真) ? readFileSync(真, 'utf8') : ''
  assert.equal(后, 前, '真实 饥饿.json 被测试改了')
})
