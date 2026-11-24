// 批次649：`记忆/冬冰/看完记.md` 写了没人读
//
// 雷霆体检一直报：冬冰/看完记.md 13KB、最后写 11-14，但代码里零引用。
// 那是她自己一条条看画面写下来的 50 条合集笔记 —— 属于「她的经历」，
// 主人提到这个合集时应该能想起来，而不是只有她手动翻文件才看得到。
// 这批只接一条窄入口：消息里出现 冬冰/看完记/合集/中转站 才扫，平时不读盘。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const lib = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 自动回忆段 } = await import(pathToFileURL(join(lib, '自动回忆.mjs')).href)

const 装沙盒 = ({ 笔记 = true, 条目 = null, 进度 = null } = {}) => {
  const b = mkdtempSync(join(tmpdir(), 't649-'))
  mkdirSync(join(b, '冬冰'), { recursive: true })
  mkdirSync(join(b, '日记'), { recursive: true })
  if (笔记) {
    const 行 = 条目 || [
      '- 角色：{{BOT_DISPLAY}}（主角，贪吃、尾巴能塞东西、下海抓鱼第一名）',
      '- 第 8 条：新室友 DeepSeek 报到，五个 AI 住进中转站，穷、抢吃的、互相嫌弃又互相护着',
      '- 第 33 条：猫神来公寓，Gemini 拖行李箱迷路，最后在豆包饭店找到',
    ]
    writeFileSync(join(b, '冬冰', '看完记.md'), '# 冬冰的《大鱼/中转站》合集看完记\n\n' + 行.join('\n') + '\n')
  }
  if (进度) writeFileSync(join(b, '冬冰', '进度.md'), 进度)
  return b
}

test('W1 主人提到冬冰合集：能翻出她自己写的笔记', () => {
  const b = 装沙盒()
  try {
    const s = 自动回忆段('冬冰那个合集你还记得吗', { mem: b, diary: join(b, '日记') })
    assert.match(s, /\[旧事素材\]/)
    assert.match(s, /冬冰 · /)
    assert.match(s, /{{BOT_DISPLAY}}|中转站|Gemini/)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W2 没提冬冰：即使文件在也不塞进来', () => {
  const b = 装沙盒()
  try {
    const s = 自动回忆段('还记得上次手账写的什么吗', { mem: b, diary: join(b, '日记') })
    assert.ok(!/冬冰 · /.test(s), '没提冬冰却召回了冬冰笔记：' + s)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W3 普通闲聊不触发（不读盘、不出块）', () => {
  const b = 装沙盒()
  try {
    assert.equal(自动回忆段('今天天气还行', { mem: b, diary: join(b, '日记') }), '')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W4 笔记不存在时问冬冰：不崩、不硬凑', () => {
  const b = 装沙盒({ 笔记: false })
  try {
    assert.equal(自动回忆段('冬冰合集讲到哪了', { mem: b, diary: join(b, '日记') }), '')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W5 超长综述条目跳过，不占回忆预算', () => {
  const 长 = '- ' + '这条是世界观综述，'.repeat(30)   // >220 字，超过 冬冰条 的单条上限
  const b = 装沙盒({ 条目: [长, '- 短条目：第 40 条是老冰棍，三万年的冰心被舔出窟窿'] })
  try {
    const s = 自动回忆段('冬冰合集里老冰棍是第几条', { mem: b, diary: join(b, '日记') })
    assert.ok(!s.includes('世界观综述'), '超长条目没被跳过')
    assert.match(s, /老冰棍/)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W6 条数受 maxItems 限制', () => {
  const b = 装沙盒()
  try {
    const s = 自动回忆段('冬冰合集都讲了什么', { mem: b, diary: join(b, '日记'), maxItems: 1 })
    const 条 = s.split('\n').filter((x) => x.startsWith('- '))
    assert.equal(条.length, 1, 'maxItems=1 却出了 ' + 条.length + ' 条')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W7 编号条目也认（真笔记 54 条是「1. …」不是「- …」）', () => {
  const b = 装沙盒({
    条目: [
      '## 一条一条',
      '1. 墨提斯三国杀充 30 块——不是这条线的，跳过没细看。',
      '12. 一人只能吃一碗嘛——去别的站讨饭，只给白饭，她还能把白饭夸成上等手艺。',
      '- **笑点最好使的是"脸"**：第 27 条她饿到炸毛那张气鼓鼓的脸。',
    ],
  })
  try {
    const s = 自动回忆段('冬冰合集里一人只能吃一碗是第几条', { mem: b, diary: join(b, '日记') })
    assert.match(s, /一人只能吃一碗/, '编号条目没被认出来：' + s)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('W8 问「讲到哪了」先给进度，不是随便一条剧情', () => {
  const b = 装沙盒({
    进度: '# 冬冰合集·逐条看画面 进度\n\n'
      + '- 已看清 45~46：45 比企鹅还圆 / 46 薄荷味\n'
      + '- 待看：47 起\n',
  })
  try {
    const s = 自动回忆段('冬冰那个合集你看到哪了', { mem: b, diary: join(b, '日记'), maxItems: 2 })
    assert.match(s, /冬冰进度/, '没给进度来源：' + s)
    assert.match(s, /待看：47 起/, '没带出当前进度')
  } finally { rmSync(b, { recursive: true, force: true }) }
})
