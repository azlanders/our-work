// t466 用量页的三个污染源：测试假记录 / omni 混进对话 / 探针冒充对话
//
// 起因（批次466）：面板上「11-14 17:05 听音频 0 / 0」「看视频 0 / 0」—— 12 毫秒、0 token、结果 ok。
// 真实 omni 调用要 0.6~6.5 秒，所以那两条根本不是调用，是 t353 注入假 fetch 之后
// 视频音频.mjs 的 记用量() 写进**真**流水（`FISH_USAGE_LOG` 没设，回落真档）。历史 366 条。
//
// 跑法：node --test t466.用量页别混假账.test.mjs

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const 面板 = join(工具, '面板.mjs')
const 真流水 = '{{DSH_ROOT}}/fish-usage-log.jsonl'

const 读 = (p) => readFileSync(p, 'utf8')

/** 数「假 omni 记录」：omni + 0 token + 用时 < 100ms。真调用不可能这么快。 */
function 数假记录() {
  if (!existsSync(真流水)) return -1
  let n = 0
  for (const ln of 读(真流水).split('\n')) {
    if (!ln.trim()) continue
    let r
    try { r = JSON.parse(ln) } catch { continue }
    if (!r.omni) continue
    const tok = (Number(r.入) || 0) + (Number(r.出) || 0)
    if (tok === 0 && (Number(r.用时毫秒) || 0) < 100 && String(r.结果 || 'ok') === 'ok') n++
  }
  return n
}

test('A1 t353 必须把用量流水指到沙盒（不是注释里提一句）', () => {
  const s = 读(join(这里, 't353.test.mjs'))
  assert.ok(/process\.env\.FISH_USAGE_LOG\s*=\s*path\.join\(mkdtempSync\(/.test(s),
    't353 没有真把 FISH_USAGE_LOG 指到沙盒 —— 它注入假 fetch，记用量会写进真流水')
})

test('A2 凡 import 视频音频/语音合成的测试，都要把 FISH_USAGE_LOG 指到沙盒', () => {
  const 缺 = []
  for (const f of readdirSync(这里)) {
    if (!f.endsWith('.mjs')) continue
    if (f === 't466.用量页别混假账.test.mjs') continue
    const p = join(这里, f)
    const s = 读(p)
    const 用到 = /from\s+'\.\/?\.\.\/视频音频\.mjs'|from\s+'\.\.\/视频音频\.mjs'|from\s+'\.\.\/语音合成\.mjs'/.test(s)
      || /import\([^)]*视频音频\.mjs/.test(s) || /import\([^)]*语音合成\.mjs/.test(s)
    if (!用到) continue
    if (!/process\.env\.FISH_USAGE_LOG\s*=/.test(s)) 缺.push(f)
  }
  assert.deepEqual(缺, [], '这些测试会往真用量流水里写假 omni 记录：' + 缺.join('、'))
})

test('A3 端到端：跑一遍 t353 的视频音频用例，真流水一条假记录都不许多', () => {
  const 前 = 数假记录()
  assert.ok(前 >= 0, '读不到真流水：' + 真流水)
  // 跑整份 t353（48 条，约 6 秒）。第一版用 --test-name-pattern 只跑视频音频那两条，
  // 结果子进程里一条都没匹配上，pass=0 —— 那种「一条都没跑」的断言等于没验，所以改成整份。
  // 子进程必须去掉 NODE_TEST_CONTEXT：Node 的测试运行器会给测试文件设它，
  // 继承下去会让「孙进程」也以为自己是某个测试的子进程，于是不打印 TAP 汇总
  // —— 实测：直接跑 `node --test t353` 有 `# pass 48`，在这里 spawn 却是 0。
  const 净env = { ...process.env }
  delete 净env.NODE_TEST_CONTEXT
  const out = execFileSync(process.execPath, ['--test', '--test-name-pattern=视频音频理解|纯音频理解', 't353.test.mjs'],
    { cwd: 这里, encoding: 'utf8', timeout: 180000, env: 净env })
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] || 0)
  assert.ok(pass >= 2,
    't353 只跑了 ' + pass + ' 条，说明它没真跑起来（断言等于没验）。输出长度 ' + out.length
    + '，尾部：' + JSON.stringify(out.slice(-160)))
  const 后 = 数假记录()
  assert.equal(后, 前, `跑完 t353 后真流水多了 ${后 - 前} 条假 omni 记录 —— FISH_USAGE_LOG 又被漏掉了`)
})

test('A4 面板用量页不把 omni 混进对话合计', () => {
  const s = 读(面板)
  assert.ok(/const rows = 读流水\(\)[\s\S]{0,400}if \(r\.omni\) return false/.test(s),
    '用量汇总没排除 omni —— 听音频/看视频会混进「她说话的 token」和「说了多少次」')
})

test('A5 面板 omni 统计必须剔掉测试噪音', () => {
  const s = 读(面板)
  assert.ok(/function 是测试噪音\(r\)/.test(s), '没有 是测试噪音 判据')
  assert.ok(/读流水\(\)\.filter\(\(r\) => r\.omni && !是测试噪音\(r\)\)/.test(s),
    'omni 统计没过滤噪音，历史 366 条假记录会被算成「听过 N 次」')
})

test('A6 探针调用要单独标成「上游探测」，不能冒充她的对话', () => {
  const s = 读(面板)
  assert.ok(/function 是探针\(r\)/.test(s), '没有 是探针 判据')
  assert.ok(/是探针\(r\) \? \{ \.\.\.r, 用途: '上游探测' \}/.test(s),
    '探针没被改标 —— 一天约 590 次连通性测试会算进「她说了多少次」')
})
