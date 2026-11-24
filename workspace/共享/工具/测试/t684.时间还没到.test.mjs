import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// 本文件只读 poll.js 源文本、不 import 插件；但 t453 的静态检查按「出现 lib 路径」判，
// 统一闭嘴，别让规则为这一个文件开口子。
process.env.QUIET_NOTE = '1'

// 批次 684：工具回执把未来时刻当结果（「20:32 醒」），她 4 秒内就讲成「睡了一下，八点半才醒」。
// 这里钉住两件事：打盹回执带「现在/还没到」，状态事实里能看见「你在打盹…还没到」。

const TOOLS = process.env.QQ_TEST_TOOLS || '{{BOT_ROOT}}/共享/工具'
const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

const 起沙盒 = () => mkdtempSync(path.join(os.tmpdir(), 't684-'))

test('N1 打盹回执带「现在」和「还没到」', () => {
  const mem = 起沙盒()
  try {
    const r = spawnSync(process.execPath, [path.join(TOOLS, '打盹.mjs'), '--开始', '45', '测试'], {
      env: { ...process.env, NAP_MEM: mem },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /现在 \d{2}:\d{2}/, '回执要带现在几点')
    assert.match(r.stdout, /还没到/, '醒的时刻要标还没到')
    assert.doesNotMatch(r.stdout, /^\s*眯 \d+ 分钟（\d{2}:\d{2} 醒）\s*$/, '不能只剩一个未来时刻')
    const nap = JSON.parse(readFileSync(path.join(mem, '打盹.json'), 'utf8'))
    assert.ok(Number(nap.到毫秒) > Date.now(), '到点仍是未来')
  } finally {
    rmSync(mem, { recursive: true, force: true })
  }
})

test('N2 已经在打盹时也只报「还没到」', () => {
  const mem = 起沙盒()
  try {
    spawnSync(process.execPath, [path.join(TOOLS, '打盹.mjs'), '--开始', '30', '第一次'], {
      env: { ...process.env, NAP_MEM: mem }, encoding: 'utf8',
    })
    const r = spawnSync(process.execPath, [path.join(TOOLS, '打盹.mjs'), '--开始', '30', '第二次'], {
      env: { ...process.env, NAP_MEM: mem }, encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /已经在打盹/)
    assert.match(r.stdout, /还没到/)
  } finally {
    rmSync(mem, { recursive: true, force: true })
  }
})

test('N3 状态事实里能看到「你在打盹…还没到」', () => {
  const mem = 起沙盒()
  try {
    const 到 = Date.now() + 40 * 60e3
    const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    writeFileSync(path.join(mem, '睡醒.json'), JSON.stringify({ sleeping: false, since: '2026-11-17 19:47' }))
    writeFileSync(path.join(mem, '打盹.json'), JSON.stringify({
      开始: bj(Date.now()), 到: bj(到), 分钟: 40, 开始毫秒: Date.now(), 到毫秒: 到,
    }))
    const 段 = 取sleepFacts(mem)
    assert.match(段, /你从 2026-11-17 19:47 起一直醒着/, '基础事实还在')
    assert.match(段, /你在打盹：\d{2}:\d{2} 开始，\d{2}:\d{2} 才醒（还没到）/, '打盹事实要带还没到')
  } finally {
    rmSync(mem, { recursive: true, force: true })
  }
})

test('N4 没在打盹就不编打盹', () => {
  const mem = 起沙盒()
  try {
    writeFileSync(path.join(mem, '睡醒.json'), JSON.stringify({ sleeping: false, since: '2026-11-17 19:47' }))
    const 段 = 取sleepFacts(mem)
    assert.doesNotMatch(段, /你在打盹/)
  } finally {
    rmSync(mem, { recursive: true, force: true })
  }
})

// 从 poll.js 抽 sleepFactsOf，注入 MEM/时钟/读档，避免 import 整个插件（会起定时器、写日志）。
function 取sleepFacts(mem) {
  const src = readFileSync(path.join(LIB, 'poll.js'), 'utf8')
  const start = src.indexOf('export function sleepFactsOf()')
  assert.ok(start > 0, 'poll.js 里找不到 sleepFactsOf')
  let i = src.indexOf('{', start)
  let dep = 0
  let end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') dep++
    else if (src[i] === '}') { dep--; if (dep === 0) { end = i + 1; break } }
  }
  const body = src.slice(start, end).replace('export function sleepFactsOf', 'function sleepFactsOf')
  const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
  const fn = new Function('MEM', 'bjDate', '快读Json', '中文时刻', 'readFileSync',
    body + '; return sleepFactsOf')(
    mem,
    () => new Date(Date.now() + 8 * 3600e3),
    (p) => 读(p),
    (h, m) => String(h) + '点' + String(m) + '分',
    readFileSync)
  return fn()
}
