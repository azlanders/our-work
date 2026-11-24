// t443.test.mjs —— 队列 TTL 宽限 + note 注入点（批次443）
//
// 起因：翻三天线上日志（11814 行）做模式聚类，两条最值得治的：
//
// ① `[out] 队列条目超时（等了 300s），也没找到可发的回复，丢弃` 出现 9 次。
//    但把会话事件流对着看，**其中 7 次的 assistant/message 在丢弃后 0–28 秒就到了**
//    （最近一次同一秒里丢完就来）。条目已经 shift 掉 → 那条回复永远发不出去。
//    主人那边看到的就是「她没理我」，而日志只有一行「丢弃」，看不出差一点就成。
//
// ② `[tool] 语音临时目录清理失败：simulated cleanup failure` 出现 86 次。
//    "simulated" 是 t354 的 D7 故意抛的；它明明传了 `note: () => {}` 想静音，
//    而 voice.js 直接调模块级 note，**根本没读 options.note** —— 注入点写了没用。
//    跟「关系卡装不下」那次一个病：测试造的数据/日志混进真档，和真故障分不出来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const LIB = process.env.PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

// note 写的是真 load.log。这个文件里的探测不该在线上留痕。
process.env.QUIET_NOTE = '1'

const OUT = path.join(LIB, 'outbound.js')
const src = readFileSync(OUT, 'utf8')

const { outbound, clearOutbound, flushOutbound } = await import(OUT)
const cfg = await import(path.join(LIB, 'config.js'))
if (typeof cfg.loadConfig === 'function') cfg.loadConfig()
const TTL = Number(cfg.getConfig().outboundEntryTtlMs) || 150000
const 宽限 = Number(cfg.getConfig().outboundEntryTtlGraceMs) || 60000

/** 造一个「已经等了多少毫秒」的队头条目。agent 用假的：eventsSince 对它返回 []。 */
const 造条目 = (sid, 已等) => {
  const agent = { session: { events: [], seq: 0 } }
  outbound.set(sid, [{ agent, cursor: 10, target: { kind: 'private', id: '1' }, userSeq: null, createdAt: Date.now() - 已等 }])
}

test('A1 到 TTL 但不丢：宽限内条目还在队列里（回复晚到还能发）', async () => {
  const sid = 't443-grace'
  clearOutbound()
  造条目(sid, TTL + 1000)
  await flushOutbound({})
  let 还剩 = outbound.get(sid) ?? []
  assert.equal(还剩.length, 1, '条目被提前丢了 —— 回复晚到 1 秒就永远发不出去')
  assert.equal(还剩[0].ttlGraced, true, '没打宽限标记，下一轮会再判一次')
  // 宽限是「撑住一段时间」，不是「多给一个 tick」—— 再刷一次还得在
  await flushOutbound({})
  还剩 = outbound.get(sid) ?? []
  assert.equal(还剩.length, 1, '只多撑了一个 tick，宽限没起作用')
})

test('A2 宽限也过了就直接丢（安全阀还在）', async () => {
  const sid = 't443-drop'
  clearOutbound()
  造条目(sid, TTL + 宽限 + 5000)
  // 第一次评估就已经过了宽限窗口 → 不该再白给 60 秒，直接走丢弃
  await flushOutbound({})
  const 还剩 = outbound.get(sid) ?? []
  assert.equal(还剩.length, 0, '超了 TTL + 宽限还不丢 —— 队头会把后面所有回复堵死')
})

test('A3 宽限必须够长：实测最慢的那次差 28 秒', () => {
  assert.ok(宽限 >= 30000, '宽限只有 ' + 宽限 + 'ms，覆盖不了实测的 28s 落后')
  assert.ok(宽限 <= 180000, '宽限 ' + 宽限 + 'ms 太长了，队头会一直占着')
})

test('A4 宽限分支不能自己出队（否则等于没宽限）', () => {
  const 起 = src.indexOf('if (到期 && entry.ttlGraced !== true && waited <= ttlMs + 宽限Ms) {')
  const 止 = src.indexOf('} else if (到期 && waited > ttlMs + 宽限Ms) {')
  assert.ok(起 > 0 && 止 > 起, '找不到宽限分支的两个锚点')
  const 段 = src.slice(起, 止)
  assert.doesNotMatch(段, /queue\.shift\(\)/, '宽限分支里出队了 —— 宽限等于没写')
  assert.doesNotMatch(段, /\bcontinue\b/, '宽限分支里 continue 了 —— 走不到下面的正常匹配')
  // 扔条目那一支必须同时要求「超过 TTL + 宽限」
  assert.match(src, /else if \(到期 && waited > ttlMs \+ 宽限Ms\) \{/, '丢弃的门槛不是 ttl + 宽限')
})

test('B1 语音清理失败必须走 options.note（注入点要真的用）', async () => {
  const voice = await import(path.join(LIB, 'voice.js'))
  const dir = await mkdtemp(path.join(os.tmpdir(), 't443-voice-'))
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'clip.wav'), Buffer.alloc(128, 7))
  const 记账 = []
  try {
    const result = await voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: true, seconds: 3 }, {
      inputDir,
      workDir,
      targets: { private: new Set(), group: new Set(['12345']) },
      run: async (command, args) => {
        if (command === 'ffprobe') return { stdout: '3.0' }
        await writeFile(args.at(-1), 'encoded')
        return { stdout: '' }
      },
      send: async () => ({ retcode: 0, data: { message_id: 88 } }),
      remove: async () => { throw new Error('simulated cleanup failure') },
      note: (tag, msg) => 记账.push([tag, msg])
    })
    // 清理失败不该影响「已经发出去了」这个事实
    assert.equal(result.message_id, 88)
    assert.equal(记账.length, 1, 'note 注入点没被调用 —— 又写进真日志了')
    assert.equal(记账[0][0], 'tool')
    assert.match(记账[0][1], /语音临时目录清理失败/)
    assert.match(记账[0][1], /simulated cleanup failure/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('B2 voice.js 里不许再直接调模块级 note 记这条', () => {
  const v = readFileSync(path.join(LIB, 'voice.js'), 'utf8')
  assert.match(v, /options\.note \?\? note/, '注入点又丢了 —— t354 的 note spy 会重新失效')
  assert.doesNotMatch(v, /try \{ note\('tool', `语音临时目录清理失败/, '退回直接调 note 了')
})

test('B3 note 单参写法不再写出 undefined（lib 里有 17 处这么调的）', () => {
  // followup.js 9 处、photoWatch.js 8 处都是 `note('[tag] 整句话')`，
  // 而 note 的签名是 (tag, message) —— 结果日志成了「[[followup] …] undefined」，
  // 三天 83 行。这些调用点没逐个改（17 处手误风险），改在 note 里归一。
  const sb = mkdtempSync(path.join(os.tmpdir(), 't443-note-'))
  try {
    const 代码 = `
      const { note } = await import(${JSON.stringify(path.join(LIB, 'env.js'))})
      note('[followup] 她说了一句等回应的话', undefined)
      note('out', '正常两参')
      note('只有一句没有方括号')
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
      encoding: 'utf8', timeout: 30000,
      // QUIET_NOTE 必须显式清空：这个测试文件顶部为了不污染真日志把它设成 1 了
      env: { ...process.env, DSH_DATA: sb, QUIET_NOTE: '' }
    })
    const log = readFileSync(path.join(sb, 'qq-bridge-load.log'), 'utf8')
    assert.doesNotMatch(log, /undefined/, '又写出 undefined 了：' + log.trim())
    assert.match(log, /\[followup\] 她说了一句等回应的话/, '单参那句没拆成 tag + 正文')
    assert.match(log, /\[out\] 正常两参/, '两参的正常写法被改坏了')
    assert.match(log, /\[只有一句没有方括号\]/, '没有方括号的单参连句子都没了')
  } finally {
    rmSync(sb, { recursive: true, force: true })
  }
})
