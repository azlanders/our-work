// t552 —— 「咖啡」不能配「吃」（批次551）
//
// 批次548 修了 `物品.mjs` 的「咖啡这份吃完了」。但同一个毛病在别处还有 **8 处**，
// 全都写死成「吃」，而 `在吃饭()` 只返回 `吃啥` 这个名字、没有类别 —— 每处都没法自己判：
//
//   go.js:89        你正坐在便利店吃咖啡，还有 4 分钟 —— 吃完再走
//   poll.js:1471    你正坐在便利店吃咖啡，还有 N 分钟（得吃完再走，走开就凉了）
//   占用.mjs:155    在便利店吃咖啡
//   吃饭.mjs:158    还在吃咖啡，剩 N 分钟
//   吃饭.mjs:175    还在吃咖啡
//   吃饭.mjs:215    坐下来吃咖啡
//   自主行动.mjs:198 在便利店吃咖啡，还有 N 分钟
//   花钱.mjs:430    坐下来吃咖啡
//
// 判据收在 `在干嘛.mjs` 的 `吃喝动词()` 一处（纯函数、不读文件），八处都问它。
//
// **教训**：批次548 改完 `物品.mjs` 我以为就完了 —— 当时只有人指着那一句「咖啡这份吃完了」，
// 而「同一个意思还能怎么写」没想全。这是「断言/修复只能抓它认识的写法」的又一例。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'

const 工具 = (process.env.QQ_WORKSPACE || '{{BOT_ROOT}}') + '/共享/工具'
const 插件 = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web/node_modules/dsh-onebot-channel/lib` : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')

const { 吃喝动词 } = await import(工具 + '/在干嘛.mjs')

test('E1 饮品一律「喝」', () => {
  for (const x of ['咖啡', '美式咖啡', '拿铁', '摩卡', '奶茶', '豆浆', '牛奶', '酸奶',
    '果汁', '可乐', '雪碧', '汽水', '啤酒', '红酒', '茶', '汤', '热水', '一杯温水', '水', '养乐多', '脉动']) {
    assert.equal(吃喝动词(x), '喝', x + ' 应该配「喝」')
  }
})

test('E2 吃的仍然是「吃」—— 别为了修咖啡把饭也改了', () => {
  for (const x of ['汉堡套餐', '自热饭', '泡面', '糖', '面包', '粥', '烧烤', '米线', '饼干', '苹果']) {
    assert.equal(吃喝动词(x), '吃', x + ' 应该配「吃」')
  }
})

test('E3 「水果」不许被「水」误伤（这条最容易写错）', () => {
  for (const x of ['水果', '水果沙拉', '水果拼盘']) {
    assert.equal(吃喝动词(x), '吃', x + ' 是吃的，不是喝的')
  }
  // 但「杯水」「热水」这种仍然要认出是喝
  for (const x of ['一杯水', '这杯水']) {
    assert.equal(吃喝动词(x), '喝', x + ' 是喝的')
  }
})

test('E4 空/没名字时回落「吃」，不炸', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(吃喝动词(v), '吃', JSON.stringify(v))
})

test('E5 八个该改的地方，一处都不许漏', () => {
  const 违规 = []
  const 检查 = (文件, 路径) => {
    const s = readFileSync(路径, 'utf8')
    // 「吃」后面直接跟 ${...} 或 + 变量，就是要修的地方
    for (const m of s.matchAll(/`[^`]*吃\$\{/g)) 违规.push(文件 + ': ' + m[0].slice(0, 50))
    for (const m of s.matchAll(/'你正坐在'[^;]*\+ '吃'/g)) 违规.push(文件 + ': ' + m[0].slice(0, 50))
  }
  检查('go.js', 插件 + '/go.js')
  检查('poll.js', 插件 + '/poll.js')
  检查('占用.mjs', 工具 + '/占用.mjs')
  检查('吃饭.mjs', 工具 + '/吃饭.mjs')
  检查('自主行动.mjs', 工具 + '/自主行动.mjs')
  检查('花钱.mjs', 工具 + '/花钱.mjs')
  assert.deepEqual(违规, [], '这些地方还写死「吃」：\n' + 违规.join('\n'))
})

test('E6 八处真的都调了 吃喝动词（不只是把模板改了）', () => {
  const 要 = [
    ['go.js', 插件 + '/go.js'],
    ['poll.js', 插件 + '/poll.js'],
    ['占用.mjs', 工具 + '/占用.mjs'],
    ['吃饭.mjs', 工具 + '/吃饭.mjs'],
    ['自主行动.mjs', 工具 + '/自主行动.mjs'],
    ['花钱.mjs', 工具 + '/花钱.mjs'],
  ]
  for (const [名, 路径] of 要) {
    const s = readFileSync(路径, 'utf8')
    assert.ok(s.includes('吃喝动词'), 名 + ' 没调 吃喝动词')
    const imported = /from\s*['"]\.\/在干嘛\.mjs['"]/.test(s) ||
      (/在干嘛\.mjs/.test(s) && /吃喝动词/.test(s))
    assert.ok(imported, 名 + ' 没 import 在干嘛.mjs')
  }
})

test('E7 真跑一次 go.js 的 eating 拒绝话（咖啡 vs 汉堡）', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { 走一趟 } = await import(插件 + '/go.js')
  const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  for (const [吃啥, 期望] of [['咖啡', '喝咖啡'], ['汉堡套餐', '吃汉堡套餐']]) {
    const b = mkdtempSync(join(tmpdir(), 't552-'))
    const now = Date.now()
    writeFileSync(join(b, '资产.json'), JSON.stringify({ 位置: '便利店', 钱: 600 }))
    writeFileSync(join(b, '吃饭.json'), JSON.stringify({
      在哪: '便利店', 吃啥, 到: bj(now + 5 * 60e3), 到毫秒: now + 5 * 60e3,
    }))
    const r = await 走一趟('家', { mem: b })
    assert.equal(r.ok, false)
    assert.ok(String(r.message).includes(期望), `${吃啥} 的话不对：${r.message}`)
    rmSync(b, { recursive: true, force: true })
  }
})
