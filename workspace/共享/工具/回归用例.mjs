#!/usr/bin/env node
// 回归用例.mjs —— 给关键行为钉几个「会失败」的用例（2026-11-04）
// 用法：node 回归用例.mjs        全部用例，失败则退出码 1
// 思路：把 状态推进.mjs 拷到临时目录、把路径换成临时记忆目录，在沙盒里真跑一次，
//      断言它算出来的数值/标签对不对；不动线上状态。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const NODE = '/usr/local/bin/node'
const results = []
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail })

/**
 * 把入口脚本的本地依赖（./x.mjs）顺着 import 全拷进沙盒。
 *
 * DEP_COPY 2026-11-07（批次175）：这里原来写死只拷 _状态.mjs。批次164 之后
 * 状态推进.mjs 又多了 睡态/_底层/自主状态/占用/在干嘛/恢复目标/饱渴 七个依赖，
 * 于是这套回归用例从那时起**一直在报错**（ERR_MODULE_NOT_FOUND file:///tmp/hf-xxx/睡态.mjs），
 * 而没人发现 —— 它不在 cron 里，只有人想跑的时候才跑，跑挂了也只当是自己手滑。
 *
 * 写死的清单一定会再烂一次（这个项目里已经烂过很多次），所以改成扫 import：
 * 加什么模块都不用改这里。
 */
function 拷依赖 (入口, 到, 沙盒记忆, 跳过 = new Set()) {
  const 已拷 = new Set()
  const 走 = (名) => {
    if (已拷.has(名) || 跳过.has(名)) return
    已拷.add(名)
    const 源 = fs.readFileSync(path.join(TOOLS, 名), 'utf8')
    for (const m of 源.matchAll(/from\s+'\.\/([^']+\.mjs)'|import\s+'\.\/([^']+\.mjs)'/g)) 走(m[1] || m[2])
    // DEP_PATCH 2026-11-14（批次456）：这里原来只给**入口**换路径，依赖是原样 copyFileSync 拷进去的。
    // 疾病.mjs 的 `MEM = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'` 原封不动，
    // 于是状态推进 每 tick 调 疾病.累/推进 都在写**线上** 记忆/疾病.json ——
    // 每跑一次回归用例就写一次，混在心跳的 15 分钟 tick 里根本看不出来（mtime 差 2 分钟也不扎眼）。
    // 所以：每个拷进去的模块都要换路径，不是只换入口。
    const 改写 = 源
      .replaceAll("'{{BOT_ROOT}}/记忆", "'" + 沙盒记忆)
      .replaceAll("'{{BOT_ROOT}}/共享/工具", "'" + path.join(到, '工具'))
    fs.writeFileSync(path.join(到, 名), 改写)
  }
  走(入口)
  return [...已拷]
}

function makeSandbox () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
  const mem = path.join(dir, '记忆')
  const toolsDir = path.join(dir, '工具')
  fs.mkdirSync(mem, { recursive: true })
  fs.mkdirSync(toolsDir, { recursive: true })
  // 困意.mjs 用桩件顶掉：真脚本会读写线上状态，测试不碰
  fs.writeFileSync(path.join(toolsDir, '困意.mjs'), "console.log('困意 0/100')")
  // 状态推进 每次 tick 会顺带跑 激素.mjs --tick（绝对路径 → 被 replaceAll 改到沙盒），这里也给它一个桩，免得子进程报 MODULE_NOT_FOUND
  fs.writeFileSync(path.join(toolsDir, '激素.mjs'), "console.log('激素 tick（测试桩）')")
  fs.writeFileSync(path.join(toolsDir, '参数.json'), '{}')
  // 拷贝脚本并把 base 指到沙盒、tools 指到一个空目录（避免它去跑真困意.mjs 误写状态）
  // 2026-11-04：状态推进 现在依赖 ./_状态.mjs（合并写入），沙盒必须一并拷进去，否则子进程报 MODULE_NOT_FOUND
  // 入口自己也拷（下面会用打过补丁的版本盖掉）—— 别把它放进「跳过」，
  // 否则递归第一步就返回，一个依赖都不拷（第一次改就踩了这个）。
  拷依赖('状态推进.mjs', dir, mem)
  const src = fs.readFileSync(path.join(TOOLS, '状态推进.mjs'), 'utf8')
  const patched = src
    .replaceAll("'{{BOT_ROOT}}/记忆", "'" + mem)
    .replaceAll("'{{BOT_ROOT}}/共享/工具", "'" + path.join(dir, '工具'))
  const script = path.join(dir, '状态推进.mjs')
  fs.writeFileSync(script, patched)
  return { dir, mem, script }
}

function bj (offsetMs = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetMs).toISOString().slice(0, 16).replace('T', ' ')
}

function runOnce ({ layers, mood, sleeping, lastMinutesAgo, sleepEndMinutesAgo, stateFile }) {
  const sb = makeSandbox()
  fs.writeFileSync(path.join(sb.mem, '睡醒.json'), JSON.stringify({ sleeping }))
  fs.writeFileSync(path.join(sb.mem, '自主.json'), JSON.stringify({ state: '发呆' }))
  if (sleepEndMinutesAgo != null) {
    fs.writeFileSync(path.join(sb.mem, '睡眠.json'), JSON.stringify({ last_sleep: { end: bj(-sleepEndMinutesAgo * 60e3) } }))
  }
  const state = { energy: 50, layers, mood: { label: mood }, 更新时间: bj(-lastMinutesAgo * 60e3) }
  fs.writeFileSync(path.join(sb.mem, '状态.json'), JSON.stringify(state))
  // MEM_ENV 2026-11-14（批次456）：路径字面量已经换过一道，这里再给 env 兜一层 ——
  // 有些模块读的是 `process.env.QQ_AUTONOMY_MEM`（疾病.mjs 就是），字面量替换碰不到 env 优先那支。
  const out = execFileSync(NODE, [sb.script, '--force'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, QQ_AUTONOMY_MEM: sb.mem },
  })
  const after = JSON.parse(fs.readFileSync(path.join(sb.mem, '状态.json'), 'utf8'))
  fs.rmSync(sb.dir, { recursive: true, force: true })
  return { out, after, state }
}

// 用例 1：睡着时认知能回来，总精力按木桶算（原来只回生理情绪、认知不回）
{
  const r = runOnce({
    layers: { physical: 60, emotional: 60, cognitive: 0, existential: 49 },
    mood: '睡着', sleeping: true, lastMinutesAgo: 60, sleepEndMinutesAgo: 60,
  })
  const c = r.after?.layers?.cognitive
  // TOLERANT 2026-11-04：睡眠回血已改成朝目标阻尼恢复（Ctarget 82），不再固定 2.5/小时，
  // 所以这里只断言「明显回升且不越界」，别锁死具体数值，免得别人调参就红。
  // SLEEP_RATE 2026-11-08（批次271）：睡眠收敛系数 0.08→0.26（一觉要能补满大部分差距），
  // 这一步从 0 回升到 21.3。这条断言的本意是「阻尼生效、不会一步冲到 82」，
  // 上限跟着放宽到 40 —— 它验的是「没有一次冲满」，不是「等于某个具体数」。
  ok('睡着：认知从 0 回升（阻尼，不会一步冲满）', typeof c === 'number' && c > 2 && c < 40, String(c))
  ok('睡着：总精力不是两数平均', r.after?.energy !== 60, String(r.after?.energy))
}

// 用例 2：认知见底时总精力不能还显示「精神」（旧 bug：89/100/1.8/49 → 95）
{
  const r = runOnce({
    layers: { physical: 89, emotional: 100, cognitive: 1.8, existential: 49 },
    mood: '平常', sleeping: false, lastMinutesAgo: 15,
  })
  ok('醒着：认知 1.8 时精力 < 35', Number(r.after?.energy) < 35, String(r.after?.energy))
}

// 用例 3：刚醒标签要按醒来时长退掉（旧 bug：按推进间隔算，永远不退）
{
  const r = runOnce({
    layers: { physical: 60, emotional: 60, cognitive: 45, existential: 49 },
    mood: '刚醒，有点懵', sleeping: false, lastMinutesAgo: 15, sleepEndMinutesAgo: 120,
  })
  ok('刚醒：清醒两小时后标签换掉', !/刚醒/.test(String(r.after?.mood?.label || '')), String(r.after?.mood?.label))
}

// 用例 4：戳一戳的合成消息必须自带「系统事件」说明，否则她会当成文字
{
  const pollPath = fs.existsSync('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js')
    ? '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
    : '{{DSH_ROOT}}/profiles/desktop/node_modules/dsh-onebot-channel/lib/poll.js'
  const src = fs.readFileSync(pollPath, 'utf8')
  ok('戳一戳：合成消息带系统事件说明', src.includes('QQ 自带的戳一戳'), '')
}

// 用例 5：面板今日睡眠要算跨零点的段（源码里应有 SLEEP_WINDOW 的按天窗口）
{
  const src = fs.readFileSync(path.join(TOOLS, '面板.mjs'), 'utf8')
  ok('面板：跨零点睡眠有按天窗口', src.includes('SLEEP_WINDOW') && src.includes('dayEnd'), '')
}

const bad = results.filter(r => !r.pass)
for (const r of results) console.log((r.pass ? '[ok] ' : '[!!] ') + r.name + (r.detail ? '  ' + r.detail : ''))
console.log('----')
console.log(bad.length === 0 ? '回归用例：全部通过' : '回归用例：' + bad.length + ' 条失败')
process.exit(bad.length === 0 ? 0 : 1)
