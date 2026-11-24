// t471 买不到的时候要把「有哪些名字」说出来
//
// 起因（批次471）：她 4 次拿自由描述当商品名（`一碗牛肉面`/`烤红薯`/`一顿正经饭`），
// `花钱.mjs` 只回一句「没有「X」这样东西」—— 她不知道表里有什么，只能再猜一个，连着试三次。
// 现在把当前地点能买到的名字列出来（没有就列表里前 14 个）+ 她现在在哪。
//
// 跑法：node --test t471.买不到要给清单.test.mjs
// 全程沙盒（QQ_AUTONOMY_MEM），走的是「名字不存在」那条早退分支，不花钱、不写档。

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const 花钱 = join(工具, '花钱.mjs')
const 商店 = JSON.parse(readFileSync(join(工具, '商店-生活.json'), 'utf8'))

function 买(名) {
  const 沙 = mkdtempSync(join(tmpdir(), 't471-'))
  try {
    return execFileSync(process.execPath, [花钱, '--买', 名], {
      cwd: 工具, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, QQ_AUTONOMY_MEM: 沙 },
    })
  } finally { rmSync(沙, { recursive: true, force: true }) }
}

test('A1 名字不存在时，必须把表里有的名字列出来', () => {
  const out = 买('烤红薯')
  assert.match(out, /烤红薯/, '没回显她填的名字')
  assert.match(out, /照抄/, '没告诉她名字要照抄，她会继续组词')
  const 名 = Object.keys(商店.商品)
  const 命中 = 名.filter((x) => out.includes(x)).length
  assert.ok(命中 >= 3, '一个商品名都没列（命中 ' + 命中 + '）—— 她只能接着猜：' + out.slice(0, 200))
})

test('A2 要带上她现在在哪（不然她不知道该挪地方还是换名字）', () => {
  const out = 买('不存在的东西zzz')
  assert.match(out, /你现在在/, '没说她现在在哪：' + out.slice(0, 200))
})

test('A3 源码里这条分支要有据可查（不是临时 msg）', () => {
  const s = readFileSync(花钱, 'utf8')
  assert.match(s, /BUY_MISS/, '没有 BUY_MISS 标记，以后被谁改回去都看不出来')
  assert.ok(!/if \(!it\) \{ console\.log\(`没有「\$\{buy\}」这样东西`\); process\.exit\(0\) \}/.test(s),
    '又退回「只说一句没有这样东西」的老写法')
})
