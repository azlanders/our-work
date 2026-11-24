// t546 —— 关系卡：bond / safety（批次546）
//
// 这张卡决定她跟每个人「有多熟、多放心」，面板和提示词读的是它的**人话**（words()），
// 不读数值。它自己写着两条硬规矩：
//   · bond 涨得慢（**每天最多 +0.01**，且要真有互动天数）—— 防一天刷满
//   · safety 快升慢降，**真越界立刻掉**
// 但这两条一条测试都没有。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 造盒 = (初始) => {
  const b = mkdtempSync(join(tmpdir(), 't546-'))
  if (初始) writeFileSync(join(b, '关系.json'), JSON.stringify(初始))
  return b
}
const 跑 = (b, ...args) => {
  try {
    return execFileSync(process.execPath, [join(工具, '关系.mjs'), ...args], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, HJ_BASE: b },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}
const 读 = (b) => JSON.parse(readFileSync(join(b, '关系.json'), 'utf8')).people
const 他 = '{{OWNER_UIN}}'

test('R1 第一次「陪伴」：bond 0 → 0.01，safety 默认 0.5 → 0.52', () => {
  const b = 造盒(null)
  跑(b, '--who', 他, '--事件', '陪伴')
  const p = 读(b)[他]
  assert.equal(p.bond, 0.01)
  assert.ok(Math.abs(p.safety - 0.52) < 1e-9, 'safety 实际 ' + p.safety)
  assert.equal(p.events, 1)
  rmSync(b, { recursive: true, force: true })
})

test('R2 同一天再「陪伴」：bond 不涨（每天 +0.01 是上限），safety 照涨', () => {
  const b = 造盒(null)
  跑(b, '--who', 他, '--事件', '陪伴')
  跑(b, '--who', 他, '--事件', '陪伴')
  const p = 读(b)[他]
  assert.equal(p.bond, 0.01, '一天刷两次 bond 就满了，日上限没生效')
  assert.ok(Math.abs(p.safety - 0.54) < 1e-9, 'safety 没有日上限，该照涨，实际 ' + p.safety)
  assert.equal(p.events, 2, '事件次数要照记（面板要看互动了多少次）')
  rmSync(b, { recursive: true, force: true })
})

test('R3 「越界」要立刻掉 —— safety -0.25，bond 也扣', () => {
  const b = 造盒({ people: { [他]: { bond: 0.3, safety: 0.8, bondDate: '', events: 5, updatedAt: 0 } } })
  跑(b, '--who', 他, '--事件', '越界')
  const p = 读(b)[他]
  assert.ok(Math.abs(p.safety - 0.55) < 1e-9, 'safety 该从 0.8 掉到 0.55，实际 ' + p.safety)
  assert.ok(Math.abs(p.bond - 0.28) < 1e-9, 'bond 该从 0.3 掉到 0.28，实际 ' + p.bond)
  rmSync(b, { recursive: true, force: true })
})

test('R4 safety 夹在 0~1，涨过头也不许出界', () => {
  const b = 造盒({ people: { [他]: { bond: 0.99, safety: 0.98, bondDate: '', events: 9, updatedAt: 0 } } })
  跑(b, '--who', 他, '--事件', '被夸')
  const p = 读(b)[他]
  assert.ok(p.safety <= 1, 'safety 超过 1 了：' + p.safety)
  assert.ok(p.bond <= 1, 'bond 超过 1 了：' + p.bond)
  rmSync(b, { recursive: true, force: true })
})

test('R5 认不得的事件名只提示，不许写盘', () => {
  const b = 造盒(null)
  const out = 跑(b, '--who', 他, '--事件', '胡说八道')
  assert.match(out, /未知事件/)
  assert.equal(existsSync(join(b, '关系.json')), false, '认不得的事件也写了盘')
  rmSync(b, { recursive: true, force: true })
})

test('R6 --show / --list 输出的是人话，不是裸数字', () => {
  const b = 造盒({ people: { [他]: { bond: 0.7, safety: 0.75, bondDate: '', events: 12, updatedAt: 0 } } })
  const show = 跑(b, '--who', 他, '--show')
  assert.match(show, /很熟/)
  assert.match(show, /很放心/)
  const list = 跑(b, '--list')
  assert.match(list, new RegExp(他))
  assert.match(list, /很熟，很放心/)
  rmSync(b, { recursive: true, force: true })
})

test('R7 关系.json 坏了要直接退出，绝不拿空库覆盖 —— 那是清空所有人', () => {
  const b = 造盒(null)
  writeFileSync(join(b, '关系.json'), '{ 这不是 json')
  const 坏 = readFileSync(join(b, '关系.json'), 'utf8')
  const out = 跑(b, '--who', 他, '--事件', '陪伴')
  assert.match(out, /读取失败/)
  assert.equal(readFileSync(join(b, '关系.json'), 'utf8'), 坏, '坏文件被覆盖了 —— 所有人的关系数据就没了')
  rmSync(b, { recursive: true, force: true })
})

test('R8 没给 --who 就打用法，不写盘', () => {
  const b = 造盒(null)
  const out = 跑(b, '--事件', '陪伴')
  assert.match(out, /用法/)
  rmSync(b, { recursive: true, force: true })
})

test('R9 两个人的卡各存一份，绝不串', () => {
  const b = 造盒(null)
  跑(b, '--who', '111', '--事件', '被夸')
  跑(b, '--who', '222', '--事件', '争吵')
  const p = 读(b)
  assert.ok(Math.abs(p['111'].safety - 0.55) < 1e-9)
  assert.ok(Math.abs(p['222'].safety - 0.38) < 1e-9)
  assert.equal(p['111'].events, 1)
  assert.equal(p['222'].events, 1)
  rmSync(b, { recursive: true, force: true })
})
