import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 批次451：会话体检只报「routes 那一条」，可他看到的那句话背后，
// 同一个工作区里还躺着 13 条、63.6MB 早就没人读的旧会话 —— 只报在用的，等于把大头藏起来。
// 所以加了「孤儿会话」统计：只算、只报，**不删**（删会话不可逆，等他点头）。
//
// 这条锁三件事：
//   ① 数得对（一层 / 两层目录都认、跨工作区累加、在用的排掉、没会话文件的不算）
//   ② 别把不存在的根当地址炸出来（返回 0，不抛）
//   ③ **它一个字都不许删** —— 目录前后逐项比对

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 造 = () => mkdtempSync(join(tmpdir(), 't451-'))
const MB = (n) => Buffer.alloc(Math.round(n * 1048576))

function 造会话(dir, id, 大小MB) {
  mkdirSync(join(dir, id), { recursive: true })
  writeFileSync(join(dir, id, 'session.v4.jsonl.zstd'), MB(大小MB))
}

/** 递归列出目录下的相对路径+大小，用来证明「一个文件都没动」 */
function 快照(dir) {
  const out = []
  const walk = (d, pre) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { out.push(pre + e.name + '/'); walk(p, pre + e.name + '/') }
      else out.push(pre + e.name + ':' + statSync(p).size)
    }
  }
  walk(dir, '')
  return out.sort()
}

test('A1 一层结构（根就是工作区）：在用的排掉，其余算孤儿，体积对得上', async () => {
  const 根 = 造()
  try {
    造会话(根, 'session-inuse', 1)
    // 四条不同体积：断言「严格递减」才有意义 —— 两条的话，不排序也可能碰巧是那个顺序
    // （第一版就是两条，把 sort 删掉照样绿）。
    造会话(根, 'session-old1', 0.1)
    造会话(根, 'session-old2', 0.2)
    造会话(根, 'session-old3', 0.3)
    造会话(根, 'session-old4', 0.4)
    const m = await import(join(TOOLS, '会话体检.mjs'))
    const r = m.孤儿统计(根, ['session-inuse'])
    assert.equal(r.条数, 4, '孤儿条数不对：' + JSON.stringify(r))
    assert.equal(r.MB, 1, '孤儿体积不对：' + JSON.stringify(r))
    assert.deepEqual(r.明细.map((x) => x.MB), [0.4, 0.3, 0.2, 0.1], '明细必须按体积严格递减')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A2 两层结构（根是 sessions/）：跨工作区累加，在用集合跨工作区生效', async () => {
  const 根 = 造()
  try {
    const a = join(根, '--ws-a--')
    const b = join(根, '--ws-b--')
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true })
    造会话(a, 'session-live-a', 1)
    造会话(a, 'session-old-a', 1)
    造会话(b, 'session-live-b', 1)
    造会话(b, 'session-old-b', 0.5)
    const m = await import(join(TOOLS, '会话体检.mjs'))
    const r = m.孤儿统计(根, ['session-live-a', 'session-live-b'])
    assert.equal(r.条数, 2, '两个工作区的孤儿都要算：' + JSON.stringify(r))
    assert.equal(r.MB, 1.5, '体积不对：' + JSON.stringify(r))
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A3 没有会话文件、名字不叫 session- 的目录都不算', async () => {
  const 根 = 造()
  try {
    mkdirSync(join(根, 'session-empty'), { recursive: true })     // 有目录没文件
    mkdirSync(join(根, 'not-a-session'), { recursive: true })     // 名字不对
    writeFileSync(join(根, 'not-a-session', 'session.v4.jsonl.zstd'), MB(1))
    const m = await import(join(TOOLS, '会话体检.mjs'))
    const r = m.孤儿统计(根, [])
    assert.equal(r.条数, 0, '不该把空目录/非会话目录算进来：' + JSON.stringify(r))
    assert.equal(r.MB, 0)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A4 根不存在时返回 0，不许抛（cron 里抛一次就是一条待办噪音）', async () => {
  const m = await import(join(TOOLS, '会话体检.mjs'))
  const r = m.孤儿统计('/tmp/绝对不存在的目录-t451', [])
  assert.deepEqual([r.条数, r.MB], [0, 0])
})

test('A5 全部在用就不报孤儿（别把 routes 里那几条算成没人读）', async () => {
  const 根 = 造()
  try {
    造会话(根, 'session-a', 1)
    const m = await import(join(TOOLS, '会话体检.mjs'))
    const r = m.孤儿统计(根, ['session-a'])
    assert.equal(r.条数, 0)
    assert.equal(r.MB, 0)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A6 它一个文件都不许动（删会话不可逆，这里只准读）', async () => {
  const 根 = 造()
  try {
    造会话(根, 'session-old1', 0.2)
    造会话(根, 'session-old2', 0.1)
    const 前 = 快照(根)
    const m = await import(join(TOOLS, '会话体检.mjs'))
    m.孤儿统计(根, [])
    const 后 = 快照(根)
    assert.deepEqual(后, 前, '孤儿统计动了文件')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('A7 会话体检.mjs 里不许出现删会话的调用', () => {
  const 源 = readFileSync(join(TOOLS, '会话体检.mjs'), 'utf8')
  const 命中 = 源.split('\n').filter((l) => /unlinkSync|rmSync|rmdirSync|rm -rf/.test(l))
  assert.deepEqual(命中, [], '会话体检里出现了删除类调用：' + 命中.join(' | '))
})
