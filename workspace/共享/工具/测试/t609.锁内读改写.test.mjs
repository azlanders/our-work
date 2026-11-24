// t609.锁内读改写.test.mjs —— 批次609（审计 P1-4）
//
// 疾病 / 饥饿 / 吃饭 原来都是「启动读整档 → 改内存 → 整档写回」，
// 心跳和面板并发时后写的那个会把别人刚写进去的字段整份抹掉。
// 改成 改档() 锁内重读后，功能结果必须和原来一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 装入 = (p, 标记 = '') => import(pathToFileURL(p).href + (标记 ? '?' + 标记 : ''))
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 读JSON = (p) => JSON.parse(readFileSync(p, 'utf8'))

function 沙盒(前缀) {
  return mkdtempSync(join(tmpdir(), 前缀))
}

function 写疾病(b, 值 = 100) {
  writeFileSync(join(b, '疾病.json'), JSON.stringify({
    当前: [], 史: [], 上月: { 月: '', 次: 0 }, 值,
    值At: 北京(Date.now() - 3600e3), 上次判At: '', 上次加重At: '',
    用药: null, 挂水At: '', 就诊: null,
  }))
}

test('D1 疾病.累：仍然是 1 小时回落 8 点，并更新值At', async () => {
  const b = 沙盒('t609-d1-')
  try {
    写疾病(b, 100)
    process.env.QQ_AUTONOMY_MEM = b
    const 疾 = await 装入(join(工具, '疾病.mjs'), 'd1')
    const now = Date.now()
    assert.equal(疾.累({ 体温: 37, 体感: 23 }, now, 0, 0), 92)
    const d = 读JSON(join(b, '疾病.json'))
    assert.equal(d.值, 92)
    assert.equal(d.值At, 北京(now))
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('D2 疾病.判(force) 加病、吃药、减重、好：写档都还在', async () => {
  const b = 沙盒('t609-d2-')
  try {
    写疾病(b, 100)
    process.env.QQ_AUTONOMY_MEM = b
    const 疾 = await 装入(join(工具, '疾病.mjs'), 'd2')
    const now = Date.now()
    const r = 疾.判({ 体温: 36.5, 体感: 20, 卡百分比: 100 }, now, true)
    assert.equal(r.中, true)
    let d = 读JSON(join(b, '疾病.json'))
    assert.equal(d.当前.length, 1)
    assert.equal(d.当前[0].名, '感冒')

    const 药 = 疾.吃药('退烧药', now)
    d = 读JSON(join(b, '疾病.json'))
    assert.equal(d.用药.名, '退烧药')
    assert.equal(药.退烧, true)

    疾.减重(0.5, now)
    d = 读JSON(join(b, '疾病.json'))
    assert.equal(d.当前.length, 0, '减到 0 以下应进史')
    assert.equal(d.史.length, 1)

    疾.判({ 体温: 36.5, 体感: 20, 卡百分比: 100 }, now + 1000, true)
    疾.好('感冒', now + 2000)
    d = 读JSON(join(b, '疾病.json'))
    assert.equal(d.当前.length, 0)
    assert.ok(d.史.some((x) => x.手动 === true), '手动好要留痕')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('D3 疾病.挂号/就诊推进：锁内改档后流程不变', async () => {
  const b = 沙盒('t609-d3-')
  try {
    写疾病(b, 700)
    process.env.QQ_AUTONOMY_MEM = b
    const 疾 = await 装入(join(工具, '疾病.mjs'), 'd3')
    // 先造一个重病：值 700 + force 判定 → 初重 0.35；手动改重到 0.8 以便走「挂水」
    const now = Date.now()
    疾.判({ 体温: 36.5, 体感: 20, 卡百分比: 100 }, now, true)
    const d0 = readFileSync(join(b, '疾病.json'), 'utf8')
    const dd = JSON.parse(d0)
    dd.当前[0].重 = 0.8
    dd.当前[0].重At = 北京(now)
    writeFileSync(join(b, '疾病.json'), JSON.stringify(dd))

    const 挂 = 疾.挂号(now)
    assert.equal(挂.ok, true)
    assert.equal(挂.方案, '挂水')
    assert.equal(读JSON(join(b, '疾病.json')).就诊.阶段, '排队')

    const 推 = 疾.就诊推进(now + 挂.分 * 60e3 + 1000)
    assert.equal(推.变, '挂水')
    assert.equal(读JSON(join(b, '疾病.json')).就诊.阶段, '挂水')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('D4 饥饿.吃 / 记一顿：顿数和饱腹缓存都落盘', async () => {
  const b = 沙盒('t609-d4-')
  try {
    process.env.HUNGER_MEM = b
    process.env.BAOKE_MEM = b
    const 饥 = await 装入(join(工具, '饥饿.mjs'), 'd4')
    const now = Date.now()
    const r = 饥.吃({ 名: '测试饭xyz', 加: 50, at: now })   // 表里没有 → 50*20=1000 kcal
    assert.equal(r.kcal, 1000)
    let d = 读JSON(join(b, '饥饿.json'))
    assert.equal(d.今天.顿, 1)
    assert.equal(d.最后吃了, '测试饭xyz')
    assert.ok(Number.isFinite(d.饱腹), '饱腹缓存要写')

    饥.记一顿({ 名: '测试饭xyz', 类别: '吃', at: now + 1000 })
    d = 读JSON(join(b, '饥饿.json'))
    assert.equal(d.今天.顿, 2)
    assert.ok(Number.isFinite(d.饱腹), '记一顿 也要刷新饱腹缓存')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('D5 吃饭 --开始/--tick/--完：锁内重写后还能正常结算', () => {
  const b = 沙盒('t609-d5-')
  try {
    const env = { ...process.env, HUNGER_MEM: b, BAOKE_MEM: b, QQ_AUTONOMY_MEM: b, QQ_WORKSPACE: b }
    const run = (...args) => execFileSync(process.execPath, [join(工具, '吃饭.mjs'), ...args], {
      encoding: 'utf8', timeout: 15000, env,
      // 结算会调 花钱.mjs --生效；沙盒里没有它，子进程报错属预期，别把栈打到测试输出。
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const 开始 = run('--开始', '--吃', '测试饭xyz', '--分钟', '20', '--类别', '吃')
    assert.match(开始, /坐下来|喝/)
    assert.ok(existsSync(join(b, '吃饭.json')))
    const 饭0 = 读JSON(join(b, '吃饭.json'))
    assert.equal(饭0.已给, 0)

    // 把开始时间往前拨 10 分钟，让 --tick 有 50% 可结算
    const 饭1 = { ...饭0, 开始: 北京(Date.now() - 10 * 60e3), 到: 北京(Date.now() + 10 * 60e3) }
    writeFileSync(join(b, '吃饭.json'), JSON.stringify(饭1))
    run('--tick')
    const 饭2 = 读JSON(join(b, '吃饭.json'))
    assert.ok(饭2.已给 > 0.3 && 饭2.已给 <= 1, `已给应在 0.3~1，实际 ${饭2.已给}`)

    run('--完')
    assert.equal(existsSync(join(b, '吃饭.json')), false, '吃完要删档')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('D6 源码回归：三个文件不再「读整档 → 写整档」', () => {
  const 疾 = readFileSync(join(工具, '疾病.mjs'), 'utf8')
  assert.doesNotMatch(疾, /写档\(P,/)
  assert.match(疾, /改档\(P,/)

  const 饥 = readFileSync(join(工具, '饥饿.mjs'), 'utf8')
  assert.doesNotMatch(饥, /save\(/, '饥饿.mjs 不应再有整档 save')
  assert.match(饥, /改档\(FILE,/)

  const 吃 = readFileSync(join(工具, '吃饭.mjs'), 'utf8')
  assert.doesNotMatch(吃, /save\(/, '吃饭.mjs 不应再有整档 save')
  assert.match(吃, /改档\(FILE,/)
})
