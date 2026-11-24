// 批次506：群里「她认不出自己名字」+「每张纯图都要解说」两条提示的回归
//
// 事故（1051483012，2026-11-15 19:13）：
//   群友「{{BOT_DISPLAY}}是个鸡鲅」   → 她「那张不是刚才那只鸡吗，画得还挺正经的」
//   群友「{{BOT_DISPLAY}}三分钟就萎了」→ 她「这医生问得一本正经的，我隔着屏幕都替他缩了一下」
// 主人当场：「token喂狗了」「图像识别功能不行导致的」。
//
// 钉三件事：① 群头部必须写明「{{BOT_DISPLAY}}」是她自己；② 纯图无正文的判据要真能判出来；
// ③ 判据不能退回 `text === ''`（textOf 会给图片生成「[图片]」，那样恒假）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 纯图无正文, 只有媒体 } = await import(LIB + '/poll.js')
const 源码 = readFileSync(LIB + '/poll.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))
  .join('\n')

const 图 = [{ type: 'image', data: { url: 'https://x/y.jpg' } }]
const 图加表情 = [{ type: 'image', data: {} }, { type: 'face', data: { id: '1' } }]
const 文字 = [{ type: 'text', data: { text: '这是什么' } }]

test('G1 纯图无正文：只有 [图片] 算纯图', () => {
  assert.equal(纯图无正文(图, '[图片]'), true)
})

test('G2 图 + 表情也算纯图', () => {
  assert.equal(纯图无正文(图加表情, '[图片][表情]'), true)
})

test('G3 图后面跟了话，不算纯图（这条要是挂了，她就会开始无视别人说的话）', () => {
  assert.equal(纯图无正文(图, '[图片] 这是什么'), false)
  assert.equal(纯图无正文([...图, ...文字], '[图片]这是什么'), false)
})

test('G4 没有图就不是纯图', () => {
  assert.equal(纯图无正文(文字, '这是什么'), false)
  assert.equal(纯图无正文([], ''), false)
  assert.equal(纯图无正文(null, '[图片]'), false)
})

test('G5 不能退回 只有媒体 的 text==="" 判据（那个恒假）', () => {
  // 同一个输入，只有媒体 判 false、纯图无正文 判 true —— 证明两条判据不是一回事。
  assert.equal(只有媒体(图, '[图片]'), false, '只有媒体 的旧语义变了？t348 会红')
  assert.equal(纯图无正文(图, '[图片]'), true)
})

test('G6 群头部必须写明她的名字，而且要在「不是用户本人」之后紧接着给', () => {
  assert.ok(源码.includes('你自己叫'), '群头部没有「你自己叫…」这句')
  assert.ok(/说到这(两个)?名字/.test(源码) && 源码.includes('就是在说你'), '没有说明名字指的是她')
  // 位置：head 的构造里必须出现，别只写在注释里
  const 段 = 源码.slice(源码.indexOf('const head = `（QQ群'), 源码.indexOf('const head = `（QQ群') + 700)
  assert.ok(段.includes('你自己叫'), '名字锚点没拼进 head 的字符串')
})

test('G7 纯图提示必须接进 notAddressedHint，不能只是拼了字符串没人用', () => {
  assert.ok(源码.includes('const mediaHint = 纯图无正文('), 'mediaHint 没调用判据')
  assert.ok(/\) \+ crowdHint \+ mediaHint/.test(源码), 'mediaHint 没拼进正文')
})

test('G8 纯图提示只报客观情况，不规定她描述、接话或沉默', () => {
  assert.ok(源码.includes('这张图没配文字、也没点你名'), '没报纯图这个客观情况')
  for (const 句 of ['不用把画面描述出来', '看一眼就够了', '不想接就别说话', '想接就接一句']) {
    assert.ok(!源码.includes(句), '还在替她规定怎么处理这张图：' + 句)
  }
})
