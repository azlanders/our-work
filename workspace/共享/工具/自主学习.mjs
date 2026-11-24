#!/usr/bin/env node
/**
 * 自主学习闭环：在独立 headless profile 中真正调用模型和插件。
 * 只负责执行一轮；什么时候学、学什么，由 自主行动.mjs 决定。
 * 用法：node 自主学习.mjs --bili READING_ID | --tieba
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync, unlinkSync, statSync, renameSync } from 'node:fs'
// LEARN_COG 2026-11-07（批次211）→ LAYERS_TRUTH 2026-11-16（批次571）：改名 学完记一笔。
// 读进去一篇不再涨 layers.cognitive（那是「此刻清醒度」，不是「学到多少」），只记心气 +0.4。
import { 学完记一笔 } from './_总线.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { join } from 'node:path'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const MEM = '{{BOT_ROOT}}/记忆'
const LOCK = join(MEM, '.自主学习.lock')
const LOG = join(MEM, '日志', '自主学习.log')
const args = process.argv.slice(2)
const mode = args[0]
const readingId = args[1] || ''
if (!['--bili', '--tieba'].includes(mode) || (mode === '--bili' && !readingId)) {
  console.log('用法：--bili READING_ID | --tieba')
  process.exit(2)
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
if (existsSync(LOCK)) {
  const old = Number(readFileSync(LOCK, 'utf8').trim())
  if (alive(old)) { console.log(`另一轮学习还在进行（pid ${old}），这轮不挤进去`); process.exit(3) }
}
// SMOKE_NO_MODEL 2026-11-14（批次455）：冒烟测试（冒烟1 / 冒烟1b）会把每个 .mjs 当 CLI 真跑一遍，
// 而这个脚本一跑就调一次真模型 —— 花钱，还在 `--data-bot-workspace-共享-工具--` 工作区留一条会话目录
// （实测已经 143 条）。冒烟里设 SMOKE_NO_MODEL=1，这里立刻退出，一个字节都不碰。
if (process.env.SMOKE_NO_MODEL === '1') {
  console.log('[冒烟] 不调模型，直接退出')
  process.exit(0)
}
writeFileSync(LOCK, String(process.pid))

// BAR_SPIN 2026-11-05（批次87）：贴吧那一轮的 {{BAR}} 一直没被替换。
// 提示词写着「这三个吧轮着来」，可她每轮看到的都是字面的 {{BAR}}，只能自己猜 ——
// 今天猜成 deepseek 是运气（插件 config 的 keywords 全是大模型相关），
// 猜顺了就会一直去同一个吧，「轮着来」这句设计从上线起就没生效。
// 吧列表从插件自己的 config 读，别在这儿再抄一份 —— 抄了改一处就分叉。
function 下一吧() {
  const CFG = '{{DSH_ROOT}}/tieba-duty/config.json'
  const 轮 = join(MEM, '贴吧轮.json')
  let bars = ['deepseek', '孙笑川', '弱智']
  try {
    const j = JSON.parse(readFileSync(CFG, 'utf8'))
    if (Array.isArray(j.bars) && j.bars.length) bars = j.bars.map(String)
  } catch { /* 读不到配置就用默认这三个，跟线上一致 */ }
  let i = 0
  try { i = Number(JSON.parse(readFileSync(轮, 'utf8')).i || 0) } catch { /* 第一次跑，从 0 开始 */ }
  const k = ((i % bars.length) + bars.length) % bars.length
  // 先写回再返回：万一这轮中途挂了，下次从下一个吧开始，不会卡死在同一个上
  try {
    const tmp = 轮 + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(tmp, JSON.stringify({ i: i + 1, at: new Date(Date.now() + 8 * 3600e3).toISOString() }) + '\n')
    renameSync(tmp, 轮)
  } catch { /* 记不上就还从 0 开始，不影响这一轮 */ }
  return bars[k]
}

/**
 * 取画面(id)：调用 看视频.mjs 出一张 16 格拼图，返回路径。
 * 任何失败都返回一句人话，让提示词里的 {{PIC}} 不会留成字面占位符
 * （批次87 的 {{BAR}} 就是这么漏给模型看的）。
 */
function 取画面(id) {
  try {
    const out = execFileSync('/bin/bash', [
      '-c', 'set -a; . /etc/dshbot.env; set +a; exec "$@"',
      '看视频', process.execPath, join(TOOLS, '看视频.mjs'), '--reading', id, '--json', '--omni',
    ], { encoding: 'utf8', timeout: 360e3, stdio: ['ignore', 'pipe', 'pipe'] })
    // BUGFIX 2026-11-07（批次153）：--json 的输出是**多行缩进 JSON**，
    // 原来 `split('\n').pop()` 只拿到最后那行 "}"，JSON.parse 必然抛，
    // 于是每一轮都退化成「没拿到画面」—— 而图其实早就出好了（记忆/视频画面/<bvid>.png）。
    // 实测踩到：她读完写「字幕和画面都没取到」，日志里 her reasoning 是
    // 「path is a parenthetical saying no frames」。从第一个 { 开始解析。
    const t = String(out).trim()
    const 起 = t.indexOf('{')
    const j = JSON.parse(起 >= 0 ? t.slice(起) : t)
    if (j.ok && j.path) {
      const av = j.音视频?.ok && typeof j.音视频.text === 'string'
        ? j.音视频.text
        : `（视频声音理解不可用：${String(j.音视频?.reason || 'not-requested')}；不要推测声音。）`
      return { path: j.path, av }
    }
    return { path: `（这轮没拿到画面：${String(j.说 || '原因不明').slice(0, 40)}。只能按文字来，别装看见）`, av: '（视频声音理解不可用；不要推测声音。）' }
  } catch {
    return { path: '（这轮没拿到画面，只能按文字来，别装看见）', av: '（视频声音理解不可用；不要推测声音。）' }
  }
}

try {
  const file = mode === '--bili' ? '自主-B站学习.md' : '自主-贴吧学习.md'
  let prompt = readFileSync(join(TOOLS, file), 'utf8').replaceAll('{{READING_ID}}', readingId)
  // {{PIC}} 2026-11-07（批次152）：给她一张画面拼图，用 read_image 看。
  // 原来她只能读到文字稿，提示词第 3 条还写着「文字没覆盖的画面不能装知道」——
  // 于是每轮都老实承认"没看到画面"。现在把 16 格拼图递到她手里。
  // 抽帧失败**不能卡住这一轮**：贴吧本来就没画面，B 站失败也只是退回纯文字。
  if (mode === '--bili') {
    const media = 取画面(readingId)
    prompt = prompt.replaceAll('{{PIC}}', media.path).replaceAll('{{AV}}', media.av)
  }
  if (mode === '--tieba') prompt = prompt.replaceAll('{{BAR}}', 下一吧())
  // 凭据只从 systemd 已有环境文件继承；不写进脚本、日志或命令行。
  const r = spawnSync('/bin/bash', [
    '-c',
    'set -a; . /etc/dshbot.env; set +a; exec dsh --profile headless "$1"',
    '自主学习',
    prompt,
  ], {
    encoding: 'utf8',
    timeout: 20 * 60e3,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: '{{DSH_ROOT}}', NO_COLOR: '1' },
  })
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n')
  appendFileSync(LOG, `\n===== ${new Date().toISOString()} ${mode} ${readingId} exit=${r.status ?? 'timeout'} =====\n${text}\n`)
  // 模型推理可能很长：保留最近约 30 万字符，防止学习日志一年长成几个 G。
  if (statSync(LOG).size > 512 * 1024) {
    const recent = readFileSync(LOG, 'utf8').slice(-300_000)
    writeFileSync(LOG, recent)
  }
  console.log(text.trim() || `（没有文字输出，exit=${r.status}）`)
  // 学习轮最后由她自己定的间隔；只认最后一个，避免推理中提到的格式干扰。
  const waits = [...text.matchAll(/下次休息[：:]\s*(\d{1,3})\s*分钟/g)]
  if (waits.length) console.log(`SELF_NEXT_MINUTES=${Number(waits.at(-1)[1])}`)
  // SELF_SUMMARY 2026-11-05：把这一轮的人话总结捞出来（stdout 里「下次休息」之前那几行），
  // 交给 自主行动.mjs 写进 自主.json。原来 note 是硬编码的「去贴吧看了一轮」，
  // 对话侧只知道她「在逛贴吧」，不知道读到了什么 —— 于是她拿别处看来的旧梗顶上。
  try {
    const out = String(r.stdout || '')
    // SELF_SUMMARY_FIX 2026-11-05：原来直接从「下次休息」之前取最后三行，
    // 结果抽到的是模型的英文思考（14:58 那轮抽出来是 "But I need date. style updatedAt..."），
    // 自主行动只能退回兜底文案「去贴吧看了一轮」，她手上依旧没有可说的内容。
    // 现在优先认她按格式写的「自述：」——唯一标记，不会和思考过程撞车。
    let summary = ''
    const said = [...out.matchAll(/^\s*自述[：:]\s*(.+)$/gm)]
      .map((m) => m[1].trim()).filter(Boolean)
    if (said.length) summary = said.at(-1)
    if (!summary) {
      // 退回老办法，但要挡住英文思考行：只留中文字数够、占比够的句子
      const head = out.split(/下次休息[：:]/)[0]
      const lines = head.split('\n').map((x) => x.trim())
        .filter((x) => x && !x.startsWith('[tieba-duty]') && !x.startsWith('[bili') && !x.startsWith('====='))
        .filter((x) => {
          const cn = (x.match(/[\u4e00-\u9fa5]/g) || []).length
          return cn >= 8 && cn / x.length > 0.35
        })
      summary = lines.slice(-3).join(' ')
    }
    summary = summary.replace(/\s+/g, ' ').trim().slice(0, 150)
    if (summary) console.log('SELF_SUMMARY=' + summary)
  } catch { /* 拿不到就算了，别让总结影响主流程 */ }
  // CONTENT_FEEL 2026-11-05（批次87）：她读完东西之后心里那一下，记成激素。
  //
  // 这里只做两件事：把她自己写下的那个词捞出来，按那个词记一笔。
  // **系统不去读内容、不去判「这篇是悲伤的」** —— 判准在她那儿，不在这儿。
  // 这一步是整套设计的分界线：内容 → 她的反应 由她完成，
  // 我们只负责「反应 → 身体底色」这一段。
  // 第一次栽跟头就是跨了这条线（正则判「滚」= 骂人，6624 条里几乎全是回滚）。
  //
  // 词不在表里就不记 —— 宁可不记，也不猜她想说什么。
  // 只在学习轮成功（exit 0）时记：中途挂掉的那轮，她可能压根没读进去。
  const FEEL_WORDS = ['看到好笑的', '看到难受的', '被打动', '看得发慌', '看得来气', '看得没劲', '看明白点什么']
  try {
    let feel = ''
    const says = [...text.matchAll(/^\s*心里[：:]\s*(\S{1,20})/gm)].map((m) => m[1].trim())
    if (says.length && r.status === 0) {
      // 她可能写成「看到好笑的（笑出声）」，用包含匹配兜一下；只认最后一个。
      const w = says.at(-1)
      feel = FEEL_WORDS.find((x) => w.includes(x)) || ''
    }
    if (feel) {
      // 去重靠 id：同一部片子重读不会重复结算；贴吧一轮一个时间戳。
      const id = mode === '--bili'
        ? 'bili:' + readingId
        : 'tieba:' + new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19)
      const hr = spawnSync(process.execPath, [join(TOOLS, '激素.mjs'), '--event', feel, '--id', id], { encoding: 'utf8', timeout: 30e3 })
      const said = String(hr.stdout || '').trim()
      console.log('SELF_FEEL=' + feel)
      appendFileSync(LOG, `[feel] ${feel} id=${id} → ${said}\n`)
    }
  } catch (e) { /* 激素记不上不影响这一轮读完的事实 */ }

  // LEARN_COG 2026-11-07（批次211）→ LAYERS_TRUTH（批次571）：读进去一篇不再涨认知。
  // 原来这里给 layers.cognitive +1.5（封 95），和「熬久了脑子糊」挤在同一个字段里，
  // 于是认知能超过设计目标 82。现在只记心气。
  // 只在成功轮（exit 0）结算：中途挂掉那轮她可能压根没读进去。
  if ((r.status ?? 1) === 0) {
    try {
      const 收 = 学完记一笔(MEM)
      appendFileSync(LOG, `[learn] 心气 → ${收.existential}（认知 ${收.cognitive} 不动 / 精力 ${收.energy}）\n`)
    } catch { /* 涨不动不影响这一轮读完的事实 */ }
  }
  if (r.error) throw r.error
  process.exitCode = r.status ?? 1
} catch (e) {
  appendFileSync(LOG, `\n===== ${new Date().toISOString()} ${mode} ERROR =====\n${e.stack || e.message}\n`)
  console.error(e.message)
  process.exitCode = 1
} finally {
  // 游标在开跑之前就前进了（见上面的 下一吧），这里只管解锁。
  //
  // 这里原来还有一段「跑完再前进游标」的写法，用了 轮转P / 下轮序号 / 本轮吧
  // 三个变量 —— 它们从头到尾没被定义过。node --check 只查语法，查不出来；
  // 而 finally 每轮都会执行，于是 mode 是 --tieba 时必抛 ReferenceError，
  // exitCode 变成 1，自主行动把它当成「这轮失败了」，note 只能走兜底文案
  // 「去贴吧看了一轮（只读，没读到也会如实记）」——
  // 她写的自述（SELF_SUMMARY）因此从来没进过 自主.json。
  // 2026-11-05 删掉。要改游标前进的时机，改 下一吧 那一处，别再分两份。
  try { unlinkSync(LOCK) } catch { /* 已不存在 */ }
}
