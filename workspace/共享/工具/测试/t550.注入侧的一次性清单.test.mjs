// t550 —— 注入侧不能用第二份「一次性动作」清单（批次549）
//
// 事故：`poll.js:1380` 手写了一份 10 个词的集合：
//   逛贴吧/看B站/学点东西/拍张照/吃点东西/买东西/打工/走动/翻旧账/打瞌睡
// 而 `在干嘛.mjs` 的 `一次性动作` 是 16 个 —— 缺的全是**每天都会发生**的：
//   喝点水 / 躺着 / 打零工 / 去医院 / 去药店 / 买瓶水
// 其中「喝点水」是她全量自主日志里第 2 高频的动作（33 条里 8 次，仅次于打瞌睡 15 次）。
//
// 后果不只是显示错：`poll.js` 用这个集合判「这件事做完了没有」。
// 她喝完水（几十秒的事），那份清单不认 → 注入里写「你自己这会儿在『喝点水』，已经 N 分钟」
// → 别人问「在忙什么」她答「在喝水」，可她早喝完了。
// 跟 活动.mjs（批次538）、状态推进.mjs（批次539）那个 doneAt 是同一件事的第三处。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

// NO_PROD_LOG 2026-11-16：t453 的 A1 要求「凡碰插件 lib 的测试都先静音」。
// 这个文件其实只 `readFileSync` 源码、不 import（不会触发 register），
// 但按那条约定一律关上，别给以后留下「为什么这个可以例外」的口子。
process.env.QUIET_NOTE = '1'

const 插件 = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web/node_modules/dsh-onebot-channel/lib` : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const 工具 = (process.env.QQ_WORKSPACE || '{{BOT_ROOT}}') + '/共享/工具'

test('M1 poll.js 必须从 在干嘛.mjs 拿清单，不许再手写一份', () => {
  const src = readFileSync(插件 + '/poll.js', 'utf8')
  const hasImport = /import\s*\{[^}]*一次性动作[^}]*\}\s*from\s*['"][^'"]*在干嘛\.mjs['"]/.test(src) ||
    /\{[^}]*一次性动作[^}]*\}\s*=\s*(?:await\s+)?import\([^)]*在干嘛\.mjs[^)]*\)/.test(src)
  assert.ok(hasImport, '没 import 共享清单')
  assert.ok(src.includes('const 一次性 = 一次性动作'), '没指向共享清单')
  // 手写的那份必须没了。只盯 `一次性` 这个名字 —— `线上` 那份是另一个概念
  // （「逛贴吧/看B站」是屏幕上的事，跟脚下的地方无关），它本来就该在那儿。
  const 手写 = /const 一次性 = new Set\(/.test(src)
  assert.equal(手写, false, '又手写了一份 —— 两份一定分叉（这已经是第 5 处）')
})

test('M2 共享清单必须覆盖那 6 个曾漏掉的词', async () => {
  const { 一次性动作 } = await import(工具 + '/在干嘛.mjs')
  for (const x of ['喝点水', '躺着', '打零工', '去医院', '去药店', '买瓶水']) {
    assert.equal(一次性动作.has(x), true, x + ' 不在清单里 —— 喝完水又会被说成还在喝')
  }
})

test('M3 「正在做」的动作不许进一次性清单（否则真逛街会被判成做完）', async () => {
  const { 一次性动作 } = await import(工具 + '/在干嘛.mjs')
  // 注意：「打工 / 打零工」确实在清单里，但那是安全的 —— 它们的 doneAt 是**班次结束时刻**
  // （未来时间），`Date.now() - doneAt` 是负数，永远不会被当成「做完了」。
  // 而它们本来也不由 push() 产生，是班次分支直接写的。所以这条不把它们算进来。
  for (const x of ['逛街', '发呆', '摸鱼', '待命', '洗澡']) {
    assert.equal(一次性动作.has(x), false, x + ' 不该在一次性清单里')
  }
})

test('M4 三处判据必须问同一份清单（活动 / 状态推进 / 注入）', () => {
  for (const f of ['活动.mjs', '状态推进.mjs']) {
    const src = readFileSync(工具 + '/' + f, 'utf8')
    assert.ok(src.includes("from './在干嘛.mjs'"), f + ' 没有从 在干嘛.mjs 拿清单')
    assert.ok(src.includes('一次性动作'), f + ' 没用 一次性动作')
  }
  // 门口那个 5 分钟门槛也得是同一个数
  const 活动 = readFileSync(工具 + '/活动.mjs', 'utf8')
  const 状态 = readFileSync(工具 + '/状态推进.mjs', 'utf8')
  assert.ok(活动.includes('5 * 60e3'), '活动.mjs 的门槛变了')
  assert.ok(状态.includes('5 * 60e3'), '状态推进.mjs 的门槛变了')
})
