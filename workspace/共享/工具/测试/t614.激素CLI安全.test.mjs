// t614.激素CLI安全.test.mjs —— 批次614
//
// 实测事故：`node 激素.mjs --help` 没有帮助分支，落到最后的默认 --tick，
// 真的推进并写盘了 0.05 小时。帮助、拼错和缺值都不该改变她的激素状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = path.join(测试目录, '..')
const 脚本 = path.join(工具, '激素.mjs')

const 跑 = (目录, 参数) => spawnSync(process.execPath, [脚本, ...参数], {
  encoding: 'utf8',
  timeout: 30_000,
  env: { ...process.env, HJ_BASE: 目录, QUIET_NOTE: '1' },
})

function 沙盒() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't614-'))
}

function 初始档() {
  const 值 = { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 }
  return {
    v: { ...值 },
    B: { ...值 },
    lastTick: Date.now() - 60_000,
    repeats: {},
    daily: { date: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), used: {} },
    测试标记: 't614',
  }
}

test('C1 --help 只打印用法，不创建也不推进状态', () => {
  const 目录 = 沙盒()
  try {
    const r = 跑(目录, ['--help'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /用法：/)
    assert.equal(fs.existsSync(path.join(目录, '激素.json')), false, '--help 不该创建状态文件')
  } finally {
    fs.rmSync(目录, { recursive: true, force: true })
  }
})

test('C2 拼错参数报错退出，原状态一字节不变', () => {
  const 目录 = 沙盒()
  try {
    const p = path.join(目录, '激素.json')
    fs.writeFileSync(p, JSON.stringify(初始档(), null, 2))
    const 前 = fs.readFileSync(p, 'utf8')
    const r = 跑(目录, ['--tickk'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /未知参数：--tickk/)
    assert.equal(fs.readFileSync(p, 'utf8'), 前)
  } finally {
    fs.rmSync(目录, { recursive: true, force: true })
  }
})

test('C3 --event 缺值报错退出，不会按未知事件顺便推进', () => {
  const 目录 = 沙盒()
  try {
    const p = path.join(目录, '激素.json')
    fs.writeFileSync(p, JSON.stringify(初始档(), null, 2))
    const 前 = fs.readFileSync(p, 'utf8')
    const r = 跑(目录, ['--event', '--id', 'x'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /参数缺少值：--event/)
    assert.equal(fs.readFileSync(p, 'utf8'), 前)
  } finally {
    fs.rmSync(目录, { recursive: true, force: true })
  }
})

test('C4 显式 --tick 仍然正常推进', () => {
  const 目录 = 沙盒()
  try {
    const r = 跑(目录, ['--tick'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /推进 /)
    assert.equal(fs.existsSync(path.join(目录, '激素.json')), true)
  } finally {
    fs.rmSync(目录, { recursive: true, force: true })
  }
})
