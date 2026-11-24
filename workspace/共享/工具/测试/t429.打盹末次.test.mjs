import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// `打盹.json` 的「为什么」是她眯之前给自己写的理由（批次398 才接通写入），
// 但醒来时文件被 unlink，理由跟着消失 —— 她每次都被系统叫醒，却不知道自己为什么睡。
// 批次423 接上：醒来留一条 打盹-末次.json，slotNapDone 在 90 分钟内提一句。
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 打盹 = join(TOOLS, '打盹.mjs')
const { slotNapDone } = await import(join(LIB, 'voiceSlots.js'))

const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 'nap423-'))
  writeFileSync(join(sb, '资产.json'), JSON.stringify({ 位置: '家' }))
  writeFileSync(join(sb, '自主.json'), JSON.stringify({ state: '待命', since: Date.now() }))
  return sb
}

function 跑(sb, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [打盹, ...args], { encoding: 'utf8', timeout: 20000, cwd: TOOLS, env: { ...process.env, NAP_MEM: sb } }) }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 读 = (sb, f) => JSON.parse(readFileSync(join(sb, f), 'utf8'))

test('N1 眯的时候写的理由，醒来还在', () => {
  const sb = 造()
  try {
    assert.equal(跑(sb, ['--开始', '20', '不想看那个表格']).code, 0)
    const n = 读(sb, '打盹.json')
    assert.equal(n.为什么, '不想看那个表格')
    assert.equal(跑(sb, ['--醒']).code, 0)
    assert.equal(existsSync(join(sb, '打盹.json')), false, '醒来该清掉打盹.json')
    const m = 读(sb, '打盹-末次.json')
    assert.equal(m.为什么, '不想看那个表格')
    assert.equal(m.分钟, 20)
    assert.ok(m.醒毫秒 > 0)
    assert.match(m.醒, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N2 到点被 tick 收走的那条路，也要留下理由', () => {
  // 两条醒来路必须都记 —— 只挂 --醒 的话，真正发生的事大多走 tick（cron 每分钟）
  const sb = 造()
  const 到 = Date.now() - 60e3
  writeFileSync(join(sb, '打盹.json'), JSON.stringify({ 开始: bj(到 - 25 * 60e3), 到: bj(到), 分钟: 25, 开始毫秒: 到 - 25 * 60e3, 到毫秒: 到, 为什么: '眼睛酸' }))
  try {
    assert.equal(跑(sb, ['--tick']).code, 0)
    assert.equal(existsSync(join(sb, '打盹.json')), false)
    const m = 读(sb, '打盹-末次.json')
    assert.equal(m.为什么, '眼睛酸')
    assert.equal(m.分钟, 25)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N3 还没到点的 tick 不许写末次（否则每一天都在「刚醒」）', () => {
  const sb = 造()
  const 到 = Date.now() + 10 * 60e3
  writeFileSync(join(sb, '打盹.json'), JSON.stringify({ 开始: bj(Date.now()), 到: bj(到), 分钟: 20, 到毫秒: 到, 为什么: 'x' }))
  try {
    const r = 跑(sb, ['--tick'])
    assert.equal(r.code, 0, r.out)
    assert.equal(existsSync(join(sb, '打盹.json')), true, '没到点不该清')
    assert.equal(existsSync(join(sb, '打盹-末次.json')), false, '没醒就写了末次')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

const 末次 = (sb, 距分钟, 为什么 = '不想看那个表格', 分钟 = 20) =>
  writeFileSync(join(sb, '打盹-末次.json'), JSON.stringify({ 分钟, 为什么, 醒毫秒: Date.now() - 距分钟 * 60e3, 醒: bj(Date.now()) }))

test('N4 只报眯了多久和几点醒，不替她描述脑子沉不沉', () => {
  const sb = 造()
  try {
    const now = Date.now()
    writeFileSync(join(sb, '打盹-末次.json'), JSON.stringify({ 分钟: 20, 为什么: '不想看那个表格', 醒毫秒: now - 2 * 60e3, 醒: bj(now) }))
    const s = slotNapDone({ memDir: sb })
    assert.match(s, /\[你眯过一会儿\] 20 分钟，\d{2}:\d{2} 醒的/, s)
    assert.match(s, /不想看那个表格/, s)
    assert.match(s, /别念出这条提示/, s)
    assert.doesNotMatch(s, /刚睁眼|脑子还沉|慢半拍/, s)
    assert.doesNotMatch(s, /醒了大半/, s)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N5 四十分钟后仍只递同一件事实，不再编「醒了大半」', () => {
  const sb = 造()
  try {
    末次(sb, 40)
    const s = slotNapDone({ memDir: sb })
    assert.match(s, /\[你眯过一会儿\] 20 分钟，\d{2}:\d{2} 醒的/, s)
    assert.doesNotMatch(s, /刚睁眼|醒了大半|脑子还沉/, s)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N6 过了 90 分钟就不再提', () => {
  const sb = 造()
  try { 末次(sb, 100); assert.equal(slotNapDone({ memDir: sb }), '') } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N7 「困了」这种我们替她填的理由，不引述成她的话', () => {
  const sb = 造()
  try {
    for (const w of ['困了', '自己觉得困']) {
      末次(sb, 3, w)
      const s = slotNapDone({ memDir: sb })
      assert.ok(s !== '', '该提还是要提')
      assert.doesNotMatch(s, /你当时给自己的理由是/, w + ' 被当成她的话引了')
    }
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N8 没有末次、分钟数是 0、时间在未来，都不许出声', () => {
  const sb = 造()
  try {
    assert.equal(slotNapDone({ memDir: sb }), '', '没文件')
    assert.doesNotThrow(() => slotNapDone({}), '不给 ctx 也不能炸')
    末次(sb, 3, 'x', 0)
    assert.equal(slotNapDone({ memDir: sb }), '', '分钟 0')
    末次(sb, -5)
    assert.equal(slotNapDone({ memDir: sb }), '', '未来时间')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('N9 自主行动抽到打瞌睡时，低体力不再写成「困了」', () => {
  const s = readFileSync(join(TOOLS, '自主行动.mjs'), 'utf8')
  assert.match(s, /实在撑不住了/, '低体力还是写「困了」')
  // 反过来：不能只剩硬编码那一支（本来就是要按体力分两种）
  assert.match(s, /'困了'/, '高位时那句「困了」不该被删')
})
