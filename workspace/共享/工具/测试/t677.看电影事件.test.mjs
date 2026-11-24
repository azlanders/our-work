// t677 —— 批次677：看电影事件名接回三条入口
//
// 现场：事件表只有「电影」，活动/计划/物品总表服务都写「看电影」，
// 激素.mjs 对未知事件返回 ok:false，三个调用点又把输出吞掉 → 0 次激素。
// 改法：活动/计划统一用正名「电影」；事件表留一条同值的「看电影」别名给存量物品表。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 根 = mkdtempSync(join(tmpdir(), 't677-film-'))
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 跑(名, id) {
  const mem = join(根, 名)
  mkdirSync(mem, { recursive: true })
  const env = { ...process.env, HJ_BASE: mem, QUIET_NOTE: '1', LOG_PREFIX_OFF: '1' }
  delete env.NODE_OPTIONS
  const out = execFileSync(process.execPath, [join(工具, '激素.mjs'), '--event', 名, '--id', id], {
    encoding: 'utf8', timeout: 30000, env,
  })
  const 档 = JSON.parse(readFileSync(join(mem, '激素.json'), 'utf8'))
  return { out, 档, mem }
}

test('C1 事件表真有「看电影」别名，且和「电影」同值', () => {
  const 源 = readFileSync(join(工具, '激素.mjs'), 'utf8')
  assert.match(源, /电影:\s*\{ dopamine: 6, oxytocin: 2 \}/)
  assert.match(源, /看电影:\s*\{ dopamine: 6, oxytocin: 2 \}/)
})

test('C2 活动/计划都不再写死未知事件名「看电影」', () => {
  const 活动 = readFileSync(join(工具, '活动.mjs'), 'utf8')
  assert.match(活动, /地点 === "电影院" \? "电影"/, '活动.mjs 还在用「看电影」')
  const 计划 = readFileSync(join(工具, '计划.mjs'), 'utf8')
  assert.match(计划, /includes\("电影"\) \? "电影"/, '计划.mjs 还在用「看电影」')
})

test('C3 「电影」和「看电影」都能真的发出多巴胺', () => {
  try {
    const a = 跑('电影', 't677-film-zheng')
    const b = 跑('看电影', 't677-film-alias')
    assert.match(a.out, /事件 电影/)
    assert.match(b.out, /事件 看电影/)
    const da = Number(a.档.v?.dopamine)
    const db = Number(b.档.v?.dopamine)
    assert.ok(Number.isFinite(da) && da > 49, '「电影」没发出多巴胺：' + da)
    assert.ok(Number.isFinite(db) && db > 49, '「看电影」没发出多巴胺：' + db)
    assert.ok(Math.abs(da - db) < 0.5, `两个名字增量不一致：${da} / ${db}`)
  } finally {
    rmSync(根, { recursive: true, force: true })
  }
})
