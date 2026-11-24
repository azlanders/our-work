// t462.插件目录别断链.test.mjs —— 批次462（2026-11-14）
//
// 从主人发的视频查下来：视频警告「上下文 75% 时插件提醒调 compress，白名单没有它 → 死循环烧 token」。
// 她这儿没有提醒型插件（live-compact 是自动压缩引擎、宿主没 compress 工具、日志 0 次），
// 但顺手查出一个真事：node_modules/dsh-compaction-pro 是个断链（指向空的 @helibeiqi/）。
// 断链平时不报错，只在加载/扫描时才炸，肉眼很难发现。
//
// 钉两件事：① 契约里有这条检查；② 现在真的没有断链。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const NM = '{{DSH_ROOT}}/profiles/web/node_modules'
const 契约 = fs.readFileSync('{{BOT_ROOT}}/共享/工具/契约检查.mjs', 'utf8')

test('A1 契约里钉了「插件目录没有断链」', () => {
  assert.ok(契约.includes('插件目录没有断链'), '契约里没有断链检查')
  assert.ok(/isSymbolicLink\(\)/.test(契约), '检查里没有用 lstat 判软链（用 stat 会把断链当不存在，直接漏掉）')
})

test('A2 现在确实没有断链', () => {
  const 断 = []
  const 走 = (d, 深) => {
    if (深 > 2) return
    let 名 = []
    try { 名 = fs.readdirSync(d) } catch { return }
    for (const f of 名) {
      const p = path.join(d, f)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) { if (!fs.existsSync(p)) 断.push(f); continue }
      if (st.isDirectory() && f !== '.bin') 走(p, 深 + 1)
    }
  }
  走(NM, 0)
  assert.deepEqual(断, [], '插件目录里有断链，加载时会炸：' + 断.join('、'))
})
