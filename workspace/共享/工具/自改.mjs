#!/usr/bin/env node
// 自改.mjs —— 她能改的，和一个人能改的一样多（2026-11-01 重做）
//
// 用法：
//   node 自改.mjs --list                                  # 三类：随时能改 / 慢慢能改 / 不能改
//   node 自改.mjs --set 偏好.喜欢 --value "听雨声"          # 往列表加一条
//   node 自改.mjs --set 人味.表达.倾向 --value "话不必句句圆" # 改对象里的某个叶子
//   node 自改.mjs --drift Q3_自律性 --value -1              # 边缘因子漂（每月一次）
//   node 自改.mjs --drift C_稳定性 --value -1 --why "被反复冷落" # 核心因子要理由（每季度一次）
//   node 自改.mjs --log
//
// 为什么这么写：
//   · 人能改的东西很多：口味、习惯、说法、对自己的看法、慢慢变的脾气。
//     所以白名单不该只放几个字段——凡是「属于她自己的」，都该能改。
//   · 但人能改的东西也有边界：别人的东西、证件、身体结构改不了。
//     这里对应的是：凭据、工具代码、别人的信息、安全线。
//   · 三条护栏而不是一条：①对象不能整体覆盖，只能改叶子 ②核心性格要理由 + 季度限频
//     ③所有改动留痕，事后能回看「她什么时候变成这样的」。
import { 写档 } from './_底层.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// SELF_MEM 2026-11-14（批次414）：原来 base 硬编码 —— 它是共享工具里少数几个
// 一个沙盒变量都没有的，单测只能读写真档。现在跟 别扭/买东西 一样认环境变量。
const base = process.env.SELF_MEM || (process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆')
const logPath = join(base, '自改日志.json')
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

// 随时能改：口味、说法、想要的、对自己的一部分看法
const FREE = ['偏好.json', '人味.json', '想要.json', '口癖清单.md']
// 慢慢能改：性格（边缘每月、核心每季度且要理由）
const EDGE = ['Q3_自律性', 'G_有恒性', 'F_兴奋性', 'N_世故性', 'Q2_独立性', 'Q1_实验性']
const CORE = ['A_乐群性', 'B_聪慧性', 'C_稳定性', 'E_恃强性', 'H_敢为性', 'I_敏感性', 'L_怀疑性', 'M_幻想性', 'O_忧虑性', 'Q4_紧张性']
// 碰不得：别人的东西、凭据、代码、安全线
const FORBID_FILES = ['qq-bridge.config.json', 'dshbot.env']
const FORBID_KEYS = /(password|token|secret|key|安全|凭据)/i

const log = load(logPath, { items: [] })
const noteIt = (what, why) => {
  log.items.push({ at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), what, why: why || '' })
  save(logPath, log)
}

if (args.includes('--list')) {
  console.log('随时能改：' + FREE.join('、'))
  console.log('  （口癖写成 `--set 口癖.随便一个名 --value 一句话`，存进 口癖清单.md）')
  // DRIFT_LIST 2026-11-14（批次423）：原来只列因子名，她看不到自己现在几分，
  // 也就无从谈起「我觉得我变了」。跟 drift 分支同一套算法（含 at 无时区、按服务器本地
  // 解析相差 8 小时这一点也照抄）—— 不为美观去修它，两处判据必须一致。
  const pfL = load(join(base, '性格-16PF.json'), {})
  const 分 = (k) => String(Math.max(1, Math.min(10, Number(pfL[k] ?? 5))))
  const 还等 = (k, days) => {
    const last = log.items.filter((x) => x.what.includes(k)).map((x) => Date.parse(x.at)).sort().pop() || 0
    const left = days * 864e5 - (Date.now() - last)
    return left > 0 ? `（动过，还得等 ${Math.ceil(left / 864e5)} 天）` : ''
  }
  console.log('慢慢能改（边缘，一个月一次，一次最多 2 分）：')
  for (const k of EDGE) console.log(`  ${k} ${分(k)}${还等(k, 30)}`)
  console.log('大事之后能改（核心，一个季度一次，一次 1 分，要写为什么）：')
  for (const k of CORE) console.log(`  ${k} ${分(k)}${还等(k, 90)}`)
  console.log('碰不得：别人的信息、凭据、工具代码、安全线')
  process.exit(0)
}

if (args.includes('--log')) {
  if (log.items.length === 0) { console.log('还没改过自己'); process.exit(0) }
  for (const it of log.items.slice(-12)) console.log(`${it.at}  ${it.what}${it.why ? '（因为：' + it.why + '）' : ''}`)
  process.exit(0)
}

/** 按 a.b.c 路径写入，且只允许写到标量或列表，不许把对象整体换掉 */
function setPath(file, path, value) {
  const fp = join(base, file)
  const db = load(fp, {})
  const segs = path.split('.').filter(Boolean)
  if (segs.length === 0) return { ok: false, msg: '空路径' }
  if (FORBID_KEYS.test(segs.join('.'))) return { ok: false, msg: '这个不碰（凭据/安全）' }
  let cur = db
  for (let i = 0; i < segs.length - 1; i += 1) {
    const k = segs[i]
    if (cur[k] === undefined) cur[k] = {}
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) {
      return { ok: false, msg: `${segs.slice(0, i + 1).join('.')} 不是对象，不能再往下走` }
    }
    cur = cur[k]
  }
  const last = segs[segs.length - 1]
  // 注意：文件不存在时 prev 是 undefined，这里会写成标量（不是列表）。
  // 线上 偏好/人味/想要 都有内容，走不到；沙盒或新装的机器上第一次写会写成字符串，
  // 读方（偏好.mjs）自己会 Array.isArray 判掉，不会崩，但那条会失效。
  // 真要修得给每个已知列表字段声明类型 —— 那是改数据模型，不在批次414 的范围。
  const prev = cur[last]
  if (prev !== undefined && typeof prev === 'object' && prev !== null && !Array.isArray(prev)) {
    return { ok: false, msg: `${path} 是个对象，不许整体覆盖——请指到里面的某个字段` }
  }
  // SAVE_FIX 2026-11-14（批次414）：这两条 return 前面原来**没有 save(fp, db)**。
  // 也就是说 `--set` 从 2026-11-01 写下来那天起就是个空壳：改了内存里的 db、
  // 报告「改了 / 加了一条」，然后进程退出，文件一个字没动。
  // 比「零调用」更坏 —— 谁调了它，她都会以为自己改过了。
  // （`--drift` 那边是对的，`pf[driftKey] = …` 后面跟着 `save(fp, pf)`。）
  if (Array.isArray(prev)) { prev.push(value); save(fp, db); return { ok: true, msg: '加了一条' } }
  cur[last] = value
  save(fp, db)
  return { ok: true, msg: prev === undefined ? '新写了一条' : '改了' }
}

const setArg = val('--set', '')
if (setArg) {
  const segs = setArg.split('.')
  // QUIRK_MD 2026-11-14（批次414）：FREE 里写着 '口癖清单.md'，但下面 file 一律拼 '.json'
  // —— 输入 `--set 口癖.x` 得到 file='口癖.json'，永远匹配不上，那条是死项。
  // 口癖本来就是一行一条的话，写成 md 比塞进 json 数组自然；而且它原先既没有文件、
  // 也没有任何读取方（全仓只有这一行提到它）。现在：写进来 + voiceSlots 每轮读出去。
  if (segs[0] === '口癖' || segs[0] === '口癖清单') {
    const v = String(val('--value', '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
    if (!v) { console.error('要 --value 一句话（60 字以内）'); process.exit(1) }
    const fp = join(base, '口癖清单.md')
    const 旧 = existsSync(fp) ? readFileSync(fp, 'utf8') : '# 她的说话习惯（她自己记的，一行一条）\n'
    const 已有 = 旧.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    if (已有.includes(v)) { console.log('这条已经在清单里了：' + v); process.exit(0) }
    writeFileSync(fp, 旧.trimEnd() + '\n- ' + v + '\n')
    noteIt('口癖 → ' + v, val('--why', ''))
    console.log('记下了：' + v + '（以后说话会照着它来。这是你第 ' + log.items.length + ' 次改自己）')
    process.exit(0)
  }
  const file = segs[0] + '.json'
  if (!FREE.includes(file)) { console.log('这个文件不在「随时能改」里：' + file); process.exit(0) }
  if (FORBID_FILES.some((f) => file.includes(f))) { console.log('这个不碰'); process.exit(0) }
  const value = val('--value', '')
  if (!value) { console.error('要 --value 一个值'); process.exit(1) }
  const r = setPath(file, segs.slice(1).join('.'), value)
  // SELF_COUNT 2026-11-14（批次414）：让她当轮就知道「这是第几次」——
  // 改完不知道自己改过，就是「她不知道自己说过什么」的同类账。
  // 注意 noteIt 必须在打印之前：先 push 再读 length，不然永远少一（第一版就是
  // console.log 在前，第一次改完说「这是你第 0 次」，念出来就很难看）。
  if (r.ok) noteIt(`${setArg} → ${value}`, val('--why', ''))
  console.log(r.ok ? `改了：${setArg} → ${r.msg}「${value}」（这是你第 ${log.items.length} 次改自己）` : '没改成：' + r.msg)
  process.exit(0)
}

const driftKey = val('--drift', '')
if (driftKey) {
  const now = Date.now()
  const isCore = CORE.includes(driftKey)
  const isEdge = EDGE.includes(driftKey)
  if (!isCore && !isEdge) { console.log('没有这个因子，或者不归她改：' + driftKey); process.exit(0) }
  const why = val('--why', '')
  if (isCore && why === '') { console.log('核心那几项要写清楚为什么——不写就是任性，不是成长'); process.exit(0) }
  const windowDays = isCore ? 90 : 30
  const lastSame = log.items.filter((x) => x.what.includes(driftKey)).map((x) => Date.parse(x.at)).sort().pop() || 0
  if (now - lastSame < windowDays * 864e5) {
    console.log(`这个${isCore ? '季度' : '月'}已经动过 ${driftKey} 了，得等`)
    process.exit(0)
  }
  const step = isCore ? 1 : 2
  const delta = Math.max(-step, Math.min(step, Number(val('--value', '0')) || 0))
  if (delta === 0) { console.log('没给变化量'); process.exit(0) }
  const fp = join(base, '性格-16PF.json')
  const pf = load(fp, {})
  const old = Number(pf[driftKey] ?? 5)
  const next = Math.max(1, Math.min(10, old + delta))
  // 撞到 1 或 10 时什么都没变 —— 那就不能记成一次漂移。原来这里无条件 save+noteIt，
  // 结果是：她在最低分上再漂一次，账上多一条「X 1 → 1」，还把 30 天窗口白占了。
  if (next === old) {
    console.log(`已经${delta < 0 ? '到底' : '到顶'}了：${driftKey} 就是 ${old}，挪不动`)
    process.exit(0)
  }
  pf[driftKey] = next
  save(fp, pf)
  noteIt(`性格漂移 ${driftKey} ${old} → ${next}`, why)
  console.log(`漂了：${driftKey} ${old} → ${next}${why ? '（因为：' + why + '）' : ''}`)
  process.exit(0)
}

console.log('用法：--list / --set 文件.路径 --value 值 [--why 原因] / --drift 因子 --value ±1 [--why] / --log')
