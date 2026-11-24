// t596 —— 记一顿必须把派生缓存「饱腹」刷新（批次596）
//
// 现场：面板直接改千卡后，`饥饿.json.饱腹` 停在 55，现算 73；
// `雷霆体检` 每周都报这条缓存漂。根因不是公式，是 `记一顿()` 只写
// 顿数/最后吃，没把派生缓存带回去。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const NODE = '/usr/local/bin/node'
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造() {
  const d = mkdtempSync(join(tmpdir(), 't596-'))
  const mem = join(d, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  writeFileSync(join(mem, '饱渴.json'), JSON.stringify({
    水: 1200, 水At: bj(now), 卡: 1000, 卡At: bj(now),
    胃: 0, 胃At: bj(now), 欠: 0, 欠At: bj(now),
    血糖: 5, 血At: bj(now), 账: [],
  }), 'utf8')
  writeFileSync(join(mem, '饥饿.json'), JSON.stringify({
    今天: { 日期: bj(now).slice(0, 10), 顿: 0, 钱: 0, 零食: 0 },
    饱腹: 5,
  }), 'utf8')
  return { 根: d, mem, now }
}

test('C1 记一顿后缓存跟现算一致，不再停在旧值', () => {
  const s = 造()
  try {
    const run = join(s.根, 'run.mjs')
    writeFileSync(run, [
      `import { 记一顿, 读 } from ${JSON.stringify(pathToFileURL(join(工具, '饥饿.mjs')).href)};`,
      `const r = 记一顿({ 名: '米饭', 类别: '吃', 价: 10, at: ${s.now} });`,
      `console.log(JSON.stringify({ r, after: 读(${s.now}).饱腹 }));`,
    ].join('\n'), 'utf8')
    const env = {
      ...process.env,
      HUNGER_MEM: s.mem, BAOKE_MEM: s.mem, GAP_MEM: s.mem,
      QQ_AUTONOMY_MEM: s.mem, QQ_ACT_MEM: s.mem, LOG_PREFIX_OFF: '1',
    }
    const out = JSON.parse(execFileSync(NODE, [run], { encoding: 'utf8', timeout: 60000, env }))
    assert.ok(out.after >= 45 && out.after <= 55, `现算应约 50，实际 ${out.after}`)
    const saved = JSON.parse(readFileSync(join(s.mem, '饥饿.json'), 'utf8'))
    assert.equal(saved.饱腹, out.after)
    assert.equal(saved.今天.顿, 1)
  } finally {
    rmSync(s.根, { recursive: true, force: true })
  }
})
