import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次447：她每轮都会读到的两句话是残的。
//
// ① `[刚刷到]` 用 `.slice(0, 55)` 硬截 —— 截在半个从句上，后面又直接贴
//    「（理解摘要是素材，不代表自身经历）」，线上长这样：
//    `…坐到沙发上低头看手机。随后她走到近景处，第一人称视角（理解摘要是素材…`
//    读起来像话说一半卡住。改成先收在句号、其次退到逗号加省略号。
// ② `昨晚睡了 6.3 小时（47 分）` —— 那个 47 是 quality×100 的分，谁读都是「47 分钟」，
//    跟 6.3 小时并排就是自相矛盾。改成「（睡得浅）」这种能拿去行动的形容。
//
// 每条判据都配了「该保留的那一边还在不在」，防止把闸做成把整句删掉。

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = LIB + '/poll.js'
const VOICE = LIB + '/voiceSlots.js'

const 造 = (p) => mkdtempSync(join(tmpdir(), p))

/** 造一条视频缓存，取回 slotJustWatched 的输出（同进程，路径靠 ctx 注入） */
async function 刷到(text, 分钟前 = 10, name = 'BVt447') {
  const root = 造('t447a-')
  const videos = join(root, '视频画面')
  mkdirSync(videos, { recursive: true })
  const now = Date.now()
  writeFileSync(join(videos, name + '.omni.json'),
    JSON.stringify({ at: new Date(now - 分钟前 * 60e3).toISOString(), text }))
  const m = await import(VOICE)
  try {
    return m.slotJustWatched({ memDir: root, videoDir: videos, peer: 'owner', ownerUin: 'owner', isPrivate: true, mute: false, now })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

/**
 * 跑一次 stateHintOf。poll.js 的 MEM 是模块顶层求值，同进程换不掉 —— 一律子进程。
 * `rec` 是睡眠记录；只给 睡眠.json 不行，整段状态注入要 状态.json 存在才进得去。
 */
function 睡眠注入(rec) {
  const sb = 造('t447b-')
  writeFileSync(join(sb, '状态.json'), JSON.stringify({
    energy: 60, mood: { label: '平常', drive: 'steady' },
    layers: { physical: 50, emotional: 50, cognitive: 60, existential: 50 }, loop: '良性',
  }))
  writeFileSync(join(sb, '睡眠.json'), JSON.stringify({ records: [rec] }))
  const 代码 = `
    const m = await import(${JSON.stringify(POLL)})
    const h = String(m.stateHintOf({ text: '', history: [], peerUin: '{{OWNER_UIN}}', isPrivate: true }) || '')
    console.log('__OUT__' + JSON.stringify(h))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_MEM: sb },
  })
  rmSync(sb, { recursive: true, force: true })
  const 行 = out.split('\n').find((l) => l.startsWith('__OUT__'))
  assert.ok(行, 'stateHintOf 没打印出结果，输出：' + out.slice(0, 400))
  return JSON.parse(行.slice('__OUT__'.length))
}

const 深睡 = { start: '2026-11-13 03:03:58', end: '2026-11-13 09:20:01' }

// ---------------- A. [刚刷到] 不许截在半个从句上 ----------------

test('A1 有句号就收在句号（线上那条 55 字正好切在「第一人称视角」中间）', async () => {
  const 长文 = '视频为动漫风格画面，开头有人推开室内门，一名蓝发女仆装角色坐在沙发上低头看手机。'
    + '随后她走到近景处，第一人称视角的手伸入画面并戳她的鼻子；她做出夸张反应。'
  const out = await 刷到(长文)
  assert.match(out, /^\[刚刷到\]/, '槽本身不出了：' + out)
  assert.match(out, /低头看手机。/, '整句没保住')
  assert.doesNotMatch(out, /随后她走到近景处/, '句号后面的内容还留着 —— 说明还是硬截')
  assert.doesNotMatch(out, /第一人称视角/, '半个从句露出来了')
  assert.match(out, /（理解摘要是素材，不代表自身经历）/, '「是素材」这句声明被一起弄丢了')
})

test('A2 短摘要原样保留，不许平白加省略号', async () => {
  const out = await 刷到('面包房传送带上连续运送面包。')
  assert.match(out, /面包房传送带上连续运送面包。/, '短摘要被改了')
  assert.doesNotMatch(out, /…/, '短摘要被加了省略号')
})

test('A3 没句号但有逗号：退到最后一个逗号，加省略号', async () => {
  // 64 字、只有逗号；硬截 60 会落在「被读到」中间，最后一个逗号在 38 位
  const 无句 = '面包房传送带上连续运送面包和可颂，还有一排排法棍整整齐齐地摆在木架上等着出炉，'
    + '后面这一截本来不该出现在提示里也不该被读到真的不该'
  assert.ok(无句.length > 60, '样例本身要超过 60 字，否则走的是原样返回分支')
  assert.doesNotMatch(无句, /[。！？!?]/, '样例不该带句号，这一条测的是逗号回退')
  const out = await 刷到(无句)
  assert.match(out, /…（理解摘要是素材/, '逗号处收尾 + 省略号没生效：' + out)
  assert.doesNotMatch(out, /本来不该出现/, '逗号后面的内容还留着')
})

test('A4 连逗号都没有：硬截但必须带省略号，且不超长', async () => {
  const out = await 刷到('面'.repeat(80))
  assert.match(out, /…（理解摘要是素材/, '硬截没标省略号 —— 她分不清是完整还是断的')
  assert.doesNotMatch(out, new RegExp('面'.repeat(61)), '硬截还超过了 60 字')
  assert.ok(out.length < 300, '单条摘要该有限长，实际 ' + out.length)
})

// ---------------- B. 睡眠质量不许写成「(N 分)」 ----------------

test('B1 quality 0.47 只报「睡眠质量 47%」，不替她判睡得浅不浅', () => {
  const h = 睡眠注入({ ...深睡, quality: 0.47074468085106386 })
  assert.match(h, /昨晚睡了 6\.3 小时/, '时长被一起弄丢了：' + h.slice(0, 300))
  assert.match(h, /（睡眠质量 47%）/, '0.47 没按百分比报')
  assert.doesNotMatch(h, /睡得浅|睡得很沉|睡得很碎/, '数值被翻译成主观睡眠评价')
  assert.doesNotMatch(h, /（\d+ 分）/, '「(47 分)」这种和小时并排自相矛盾的写法还在')
})

test('B2 quality 0.9 报「睡眠质量 90%」，不判「睡得很沉」', () => {
  const h = 睡眠注入({ ...深睡, quality: 0.9 })
  assert.match(h, /（睡眠质量 90%）/, '高质量睡眠没按百分比报')
  assert.doesNotMatch(h, /睡得浅|睡得很沉|睡得很碎/, '数值被翻译成主观睡眠评价')
})

test('B3 score 是 0~1 小数也按比例报，不判「睡得很碎」', () => {
  // 记录里两种量纲都见过：quality 恒 0~1，score 可能 0~1 也可能 0~100
  const h = 睡眠注入({ ...深睡, score: 0.47 })
  assert.match(h, /（睡眠质量 47%）/, 'score=0.47 没按 47% 报：' + (h.match(/昨晚睡了[^，]*/) || [''])[0])
  assert.doesNotMatch(h, /睡得很碎/, '0.47 被当成 0.47 分 → 判成最碎那档')
})

test('B4 没有质量字段就只说到小时，不许挂个空括号', () => {
  const h = 睡眠注入({ ...深睡 })
  assert.match(h, /昨晚睡了 6\.3 小时/, '时长没了')
  assert.doesNotMatch(h, /昨晚睡了[^，]*（/, '没有质量数据却挂了括号：' + (h.match(/昨晚睡了[^，]*/) || [''])[0])
})
