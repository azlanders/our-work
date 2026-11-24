// t456.回归用例沙盒.test.mjs —— 批次456（2026-11-14）
//
// 病根：`回归用例.mjs` 的 拷依赖() 只给**入口** 状态推进.mjs 换路径，依赖是 copyFileSync 原样拷的。
// 疾病.mjs 的 `MEM = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'` 原封不动，
// 于是状态推进 每 tick 调 疾病.累/推进 都在写**线上** 记忆/疾病.json。
// 契约检查 每次都跑 回归用例（自检那一节），所以「跑一次契约检查 = 写一次她的病历」。
// 实测：连跑两次契约检查，疾病.json mtime 两次都变（05:47:35 → 05:48:08 → 05:48:11）。
//
// 这个文件钉两件事：① 拷进去的每个模块都换路径，不裸拷；② 子进程 env 兜一层；
// ③ 真跑一次，真档不变（撞上心跳就重试一次，仍撞上就 skip —— 不算通过）。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 源 = readFileSync(TOOLS + '/回归用例.mjs', 'utf8')
const 真档 = ['疾病.json', '状态.json', '自主.json'].map((n) => '{{BOT_ROOT}}/记忆/' + n)

// 指纹 = 内容 md5 + mtime + 大小。
// 只比内容会漏：疾病.mjs 写回时若「值 0 + 值At 到分钟」，同一分钟内写两次内容字节完全一样，
// 第一次红了、重试一次就绿了（反测3 当场这么骗过去一次）。mtime 每次都变，躲不掉。
const 指纹 = (p) => {
  try {
    const st = statSync(p)
    return createHash('md5').update(readFileSync(p)).digest('hex').slice(0, 8) + ':' + st.size + ':' + st.mtimeMs
  } catch { return 'missing' }
}
const 快照 = () => 真档.map(指纹).join('|')

// 疾病.log 末行时间：用来判断这次窗口里心跳的 疾病.mjs --tick 有没有插进来
const 疾病日志末行 = () => {
  try {
    const 行 = readFileSync('{{BOT_ROOT}}/记忆/日志/疾病.log', 'utf8').trim().split('\n')
    return 行[行.length - 1] || ''
  } catch { return '' }
}

test('A1 拷依赖 必须对拷入内容做路径替换（不能只换入口）', () => {
  const i = 源.indexOf('function 拷依赖')
  assert.ok(i > 0, '回归用例.mjs 里找不到 拷依赖')
  const j = 源.indexOf('\n}\n', i)
  const 体 = 源.slice(i, j)
  // 源码写法是 replaceAll("'{{BOT_ROOT}}/记忆", "'" + 沙盒记忆)
  // —— 引号后面紧跟一个单引号，第一版正则漏了它，明明改好了却报红。
  assert.ok(/replaceAll\(\s*"'\/data\/bot-workspace\/记忆/.test(体),
    '拷依赖 函数体里没有替换 记忆 路径 —— 依赖会原样拷进沙盒，继续写真档')
  assert.ok(/replaceAll\(\s*"'\/data\/bot-workspace\/共享\/工具/.test(体),
    '拷依赖 函数体里没有替换 共享/工具 路径 —— 依赖会去跑真工具')
  // writeFileSync 的第二个参数必须是改写后的内容（中间隔着 path.join(...) 有右括号，
  // 所以不能用 [^)]* 一路匹配到底）
  assert.ok(/writeFileSync\([^\n]{0,120},\s*改写\)/.test(体),
    '拷依赖 写的是原内容不是改写后的内容（要 writeFileSync(..., 改写)）')
})

test('A2 回归用例里不许再出现裸 copyFileSync（注释里的不算）', () => {
  // 注释里提到 copyFileSync 是在说明历史原因，不能算违规；
  // 但也不能因为「注释里有这个词」就永远红 —— 只查真正的调用行。
  const 调用行 = 源.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => /copyFileSync\s*\(/.test(l))
  assert.deepEqual(调用行, [],
    '出现 copyFileSync 调用 —— 原样拷模块进沙盒，依赖的绝对路径没换，会写线上真档')
})

test('A3 子进程 env 必须兜一层 QQ_AUTONOMY_MEM', () => {
  assert.ok(/QQ_AUTONOMY_MEM\s*:\s*sb\.mem/.test(源),
    'execFileSync 的 env 里没有 QQ_AUTONOMY_MEM —— 读 env 的模块（疾病.mjs）仍会落到真目录')
})

test('A4 真跑一次回归用例，真档一个字节都不变', (t) => {
  let 前 = 快照(); let 日志前 = 疾病日志末行()
  execFileSync('/usr/local/bin/node', [TOOLS + '/回归用例.mjs'], { encoding: 'utf8', timeout: 60000 })
  let 后 = 快照(); let 日志后 = 疾病日志末行()
  if (前 !== 后 || 日志前 !== 日志后) {
    // 心跳的 疾病 --tick 每 15 分钟一次，插进这 3 秒的概率很低；撞上了重试一次。
    前 = 快照(); 日志前 = 疾病日志末行()
    execFileSync('/usr/local/bin/node', [TOOLS + '/回归用例.mjs'], { encoding: 'utf8', timeout: 60000 })
    后 = 快照(); 日志后 = 疾病日志末行()
    if (日志前 !== 日志后) { t.skip('两次都撞上心跳的 疾病 --tick，判不了'); return }
  }
  const 变了 = 真档.filter((p, i) => 前.split('|')[i] !== 后.split('|')[i])
  assert.deepEqual(变了, [], '回归用例 改动了线上真档：' + 变了.join(', '))
})

test('A5 契约检查整条链也不写真档（它就是跑 回归用例 的那个人）', (t) => {
  // FLAKE_FIX 2026-11-15（批次508）：这三个档线上本来就有人写 ——
  // 自主行动 每分钟写 自主.json，状态推进 动 状态.json。契约检查 要跑 3 秒多，撞得上。
  // 文件头注释第 10 行写着「撞上心跳就重试一次」，但代码里从来没实现过。
  // 实测全套并发跑 671 项时红过一次（单跑 5/5、连跑 3 次全绿），就是它。
  const 跑一次 = () => {
    const 前 = 快照(); const 日志前 = 疾病日志末行()
    execFileSync('/usr/local/bin/node', [TOOLS + '/契约检查.mjs'], { encoding: 'utf8', timeout: 300000 })
    const 后 = 快照(); const 日志后 = 疾病日志末行()
    const 变了 = 真档.filter((p, i) => 前.split('|')[i] !== 后.split('|')[i])
    return { 变了, 日志变了: 日志前 !== 日志后 }
  }
  let r = 跑一次()
  if (r.变了.length > 0 || r.日志变了) {
    // 撞上后台就重试一次（注释里承诺的行为，这次真补上）
    r = 跑一次()
  }
  if (r.日志变了) { t.skip('窗口里混进了心跳的 疾病 --tick，判不了'); return }
  assert.deepEqual(r.变了, [], '契约检查 改动了线上真档（重试后仍然变）：' + r.变了.join(', '))
})
