// _锁.mjs 深度测试。两层：
//   A 单元语义（单进程）：抢/放/超时/strict/过期清理/锁名净化
//   B 真并发：20 个进程同时「读-改-写」同一个文件，看丢不丢更新
//
// B 是重点 —— 记忆里记着「资产.json 三处裸读改写，20 并发丢 45%；
// 换成 _底层.改档（锁内重读）丢 0」。这条要用真进程复现一遍。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// SB_UNIQUE 2026-11-14（批次437）：原来写死 /tmp/sb388，而 t399.黑话 用的也是这个路径，
// 两个测试在全套里是并行进程 —— t399 在文件顶部一句 rmSync 就能把 t388 的锁目录删掉，
// 于是「单跑绿、全套红」。沙盒各自 mkdtemp，谁也不踩谁。
const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'sb388-'))
const 锁 = 沙 + '/.locks'
const 清 = () => { fs.rmSync(沙, { recursive: true, force: true }); fs.mkdirSync(锁, { recursive: true }) }
清()

// _锁 的 LOCK_DIR 是顶层求值，必须 import 前设
process.env.QQ_LOCK_DIR = 锁
delete process.env.QQ_LOCK_WAIT_MS

const { 加锁 } = await import('{{BOT_ROOT}}/共享/工具/_锁.mjs')
const { 改档 } = await import('{{BOT_ROOT}}/共享/工具/_底层.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const 锁们 = () => fs.readdirSync(锁).filter((x) => x.endsWith('.lock'))

// ══════════ A1 基础：抢 → 放 → 再抢 ══════════
{
  清()
  const 放 = 加锁('a.json')
  加('A1 抢到后锁目录里有 1 把', 锁们().length, 1)
  加('A1 锁名带 .lock 后缀', 锁们()[0], 'a.json.lock')
  放()
  加('A1 释放后锁目录空', 锁们().length, 0)
  const 放2 = 加锁('a.json')
  加('A1 释放后能再抢到', 锁们().length, 1)
  放2()
}
{
  // 重复释放不该报错，也不该把别人的锁删掉
  清()
  const 放 = 加锁('b.json')
  放(); 放(); 放()
  加('A2 重复释放不报错', 锁们().length, 0)
}
{
  // 先拿 A 再拿 B，两把锁并存；放 A 不能影响 B
  清()
  const 放A = 加锁('a.json')
  const 放B = 加锁('b.json')
  加('A3 两把不同的锁并存', 锁们().length, 2)
  放A()
  加('A3 放 A 之后只剩 B', 锁们().join(','), 'b.json.lock')
  放B()
}
{
  // 同一把锁重入：等 2 秒后放弃（非严格模式返回空函数，不抛）
  清()
  const 放1 = 加锁('c.json')
  const t0 = Date.now()
  const 放2 = 加锁('c.json')
  const 用了 = Date.now() - t0
  加('A4 重入会在 ~2 秒后放弃', 用了 >= 1900 && 用了 <= 3200, true)
  加('A4 放弃后锁还在（是别人的）', 锁们().length, 1)
  放2(); 放1()
  加('A4 放 2 没有误删 1 的锁', 锁们().length, 0)
}
{
  // strict 模式抢不到要抛
  清()
  const 放1 = 加锁('d.json', { strict: true })
  let 抛了 = false, 消息 = ''
  try { 加锁('d.json', { strict: true, waitMs: 100 }) } catch (e) { 抛了 = true; 消息 = String(e.message) }
  加('A5 strict 抢不到会抛', 抛了, true)
  加('A5 strict 的错说清是锁超时', 消息.includes('文件锁超时'), true)
  放1()
}
{
  // waitMs: 0 → 立刻放弃
  清()
  const 放1 = 加锁('e.json')
  const t0 = Date.now()
  加锁('e.json', { waitMs: 0 })
  加('A6 waitMs:0 立刻返回（不等 2 秒）', Date.now() - t0 < 200, true)
  放1()
}
{
  // waitMs 从 env 来
  清()
  process.env.QQ_LOCK_WAIT_MS = '150'
  const 放1 = 加锁('f.json')
  const t0 = Date.now()
  加锁('f.json')
  加('A7 QQ_LOCK_WAIT_MS=150 生效', Date.now() - t0 < 800, true)
  delete process.env.QQ_LOCK_WAIT_MS
  放1()
}
{
  // 过期锁（11 秒前）会被清掉并抢到
  清()
  const p = path.join(锁, 'g.json.lock')
  fs.mkdirSync(p)
  const 旧 = new Date(Date.now() - 11_000)
  fs.utimesSync(p, 旧, 旧)
  const t0 = Date.now()
  const 放 = 加锁('g.json')
  加('A8 过期锁能被抢过来（不用等满 2 秒）', Date.now() - t0 < 1500, true)
  加('A8 抢过来后锁还在（自己的）', 锁们().length, 1)
  放()
}
{
  // 未过期（5 秒前）的锁不会被抢
  清()
  const p = path.join(锁, 'h.json.lock')
  fs.mkdirSync(p)
  const 旧 = new Date(Date.now() - 5000)
  fs.utimesSync(p, 旧, 旧)
  const t0 = Date.now()
  加锁('h.json', { waitMs: 200 })
  加('A9 未过期的锁不会抢（会等满 waitMs）', Date.now() - t0 >= 180, true)
}
{
  // 锁名净化：路径分隔符和非 ASCII 符号都变成 _
  清()
  const 放1 = 加锁('a/b.json')
  加('A10 斜杠被替换', 锁们()[0], 'a_b.json.lock')
  放1()
  清()
  const 放2 = 加锁('记忆/资产.json')
  加('A10 中文和斜杠都保留/替换正确', 锁们()[0], '记忆_资产.json.lock')
  放2()
}
{
  // ★ 锁名碰撞：a/b.json 和 a_b.json 是同一把
  清()
  const 放1 = 加锁('x/y.json', { waitMs: 0 })
  加('A11 不同路径净化后同名 → 同一把锁（碰撞是已知代价）', 锁们()[0], 'x_y.json.lock')
  const t0 = Date.now()
  加锁('x_y.json', { waitMs: 150 })
  加('A11 因此它们互斥（会等）', Date.now() - t0 >= 130, true)
  放1()
}
{
  // LOCK_DIR 建不出来时的行为：非严格返回空函数，严格抛
  清()
  const 坏 = 沙 + '/不是目录'
  fs.writeFileSync(坏, 'x', 'utf8')
  process.env.QQ_LOCK_DIR = 坏 + '/.locks'
  const 新锁 = (await import('{{BOT_ROOT}}/共享/工具/_锁.mjs?重新载入=1')).加锁
  let 崩 = false
  try { 新锁('z.json') } catch { 崩 = true }
  加('A12 LOCK_DIR 建不出来 · 非严格模式不抛', 崩, false)
  let 崩2 = false
  try { 新锁('z.json', { strict: true }) } catch { 崩2 = true }
  加('A12 LOCK_DIR 建不出来 · 严格模式抛', 崩2, true)
  process.env.QQ_LOCK_DIR = 锁
}

// ══════════ B 真并发：20 个进程同时改同一个文件 ══════════
const 并发 = 20
// 起跑对齐：让 20 个子进程都等到同一个绝对时刻才动手。
// 不这么做的话它们会错开几百毫秒，裸写也能侥幸不丢（实测三轮里有一轮 20/20）。
const 跑一批 = async (方式, 轮 = 1) => {
  const 目标 = 沙 + '/并发-' + 方式 + '-' + 轮 + '.json'
  fs.writeFileSync(目标, JSON.stringify({ n: 0 }), 'utf8')
  const 起跑 = Date.now() + 1200
  const 等 = `const 等=${起跑}-Date.now();if(等>0){const t=Date.now();while(Date.now()-t<等){}};`
  const 码 = 方式 === '锁'
    ? 等 + `import('{{BOT_ROOT}}/共享/工具/_底层.mjs').then(m=>m.改档(${JSON.stringify(目标)},a=>{a.n=(Number(a.n)||0)+1}))`
    : 等 + `const fs=require('fs');const p=${JSON.stringify(目标)};const a=JSON.parse(fs.readFileSync(p,'utf8'));a.n=(Number(a.n)||0)+1;fs.writeFileSync(p,JSON.stringify(a))`
  const 子们 = []
  for (let i = 0; i < 并发; i++) {
    子们.push(new Promise((ok) => {
      const p = spawn(process.execPath, ['-e', 码], { stdio: 'ignore', env: { ...process.env } })
      p.on('exit', ok); p.on('error', ok)
    }))
  }
  await Promise.all(子们)
  return JSON.parse(fs.readFileSync(目标, 'utf8')).n
}

const 带锁们 = []
const 裸们 = []
for (let r = 1; r <= 4; r++) {
  带锁们.push(await 跑一批('锁', r))
  裸们.push(await 跑一批('裸', r))
}
加('B1 ★ 20 并发 ×4 轮 · 用 改档（锁内重读）→ 一次不丢', 带锁们.join(','), '20,20,20,20')
// 裸写本来就不保证，这里只要求「四轮里至少丢过一次」—— 证明对照有效
加('B2 20 并发 · 裸读-改-写 → 四轮里至少丢过（证明对照有效）', 裸们.some((x) => x < 并发), true)
console.log(`并发对照（4 轮）：带锁 ${带锁们.join('/')}，裸写 ${裸们.join('/')}`)

fs.rmSync(沙, { recursive: true, force: true })
let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  const 同 = JSON.stringify(实) === JSON.stringify(期)
  if (同) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
