import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 批次 692：刷一刷只抓标题，她却讲「底下一堆人认真分析」。注入里要把「只划到标题、没点开」说清楚。
process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

function 取刚划到(mem) {
  const src = readFileSync(join(LIB, 'poll.js'), 'utf8')
  const start = src.indexOf('export function 刚划到段()')
  assert.ok(start > 0, 'poll.js 里找不到 刚划到段')
  let i = src.indexOf('{', start)
  let dep = 0
  let end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') dep++
    else if (src[i] === '}') { dep--; if (dep === 0) { end = i + 1; break } }
  }
  const body = src.slice(start, end).replace('export function 刚划到段', 'function 刚划到段')
  const fn = new Function('MEM', '快读Json', body + '; return 刚划到段')(
    mem,
    (p) => JSON.parse(readFileSync(p, 'utf8')))
  return fn()
}

test('J1 注入写明「只划到标题（没点开）」', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now(), 平台: '贴吧',
      最近: [{ 标题: '有人为了表情包跟对象分手了' }, { 标题: '全网首例' }],
    }))
    const 段 = 取刚划到(mem)
    assert.match(段, /只划到标题（没点开）/, '没写清楚只看过标题')
    assert.match(段, /贴吧/)
    assert.doesNotMatch(段, /划到：/, '别再用「划到：」这种像看过正文的说法')
    assert.ok(段.length <= 61, `段太长：${段.length}`)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('J2 超过 90 分钟就不提，避免旧标题被当成刚看的', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now() - 3 * 3600e3, 平台: 'B站', 最近: [{ 标题: '旧标题' }],
    }))
    assert.equal(取刚划到(mem), '')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

// 批次 694：刷贴吧时会顺带点开一条读正文。读到正文和只划到标题，是两种不同的事实，
// 注入必须分开说 —— 否则要么她不敢讲（明明读了），要么她讲过头（只读了楼主就编评论）。
test('J3 读到正文时摆正文，并说清「点开看了一条」', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now(), 平台: '贴吧',
      最近: [
        { id: '1', 标题: '问一嘴API怎么弄', 正文: '如题，手机端经常弄些体脂记录，数据丢了重记怪麻烦的，该怎么弄这个api呢？' },
        { id: '2', 标题: '斩杀DS？Gemini4 Hy这么强吗', 正文: '' },
      ],
    }), 'utf8')
    const 段 = 取刚划到(mem)
    assert.match(段, /点开看了/, '读到正文却没写「点开看了」')
    assert.match(段, /体脂记录/, '正文没带进去')
    assert.match(段, /只划到标题、没点开的/, '同一批里没点开的那条要分开说')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('J4 只有标题时不许出现正文口吻', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now(), 平台: '贴吧',
      最近: [{ id: '1', 标题: '问一嘴API怎么弄', 正文: '' }],
    }), 'utf8')
    const 段 = 取刚划到(mem)
    assert.match(段, /只划到标题（没点开）/)
    assert.doesNotMatch(段, /点开看了/)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

// 批次695：主人要求楼层回复一起读。注入要把「楼里别人说的」和她读到的正文分开，
// 否则她会把别人的话当成自己的想法讲出去。
test('J5 楼层回复进注入，并且标明是「有人回」', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now(), 平台: '贴吧',
      最近: [{
        id: '1',
        标题: '我才知道，原来海天酱油是海地品牌',
        正文: '据说是某海地人发明的',
        回复: ['那海底捞是海地捞的吧', '天对地。海天可不就是海地，对上了。'],
      }],
    }), 'utf8')
    const 段 = 取刚划到(mem)
    assert.match(段, /下面有人回/, '楼层回复没进注入')
    assert.match(段, /海底捞是海地捞的/, '回复内容没带进去')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('J6 回复最多带三层，别把整帖搬进上下文', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now(), 平台: '贴吧',
      最近: [{
        id: '1', 标题: '测试帖', 正文: '楼主的正文内容够长了吧',
        回复: ['一层回复内容', '二层回复内容', '三层回复内容', '四层回复内容', '五层回复内容'],
      }],
    }), 'utf8')
    const 段 = 取刚划到(mem)
    assert.match(段, /一层回复内容/)
    assert.doesNotMatch(段, /四层回复内容/, '回复没截到三层')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

// 批次695 真实数据里抓到的 bug：读过的帖子被列进「另外只划到标题、没点开的」，
// 等于告诉她「你没读过」—— 那是反方向的事实错误，比少说一句更糟。
test('J7 已读过正文的帖子不许出现在「没点开」那句里', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({
      at: Date.now(), 平台: '贴吧',
      最近: [
        { id: '1', 标题: '二手短视频', 正文: '前者对身体有害，后两者对精神有害', 回复: ['进算法'] },
        { id: '2', 标题: '熬夜了又睡不着', 正文: '睡得少明天也要早起', 回复: ['已婚微寡'] },
        { id: '3', 标题: '真的只看到标题', 正文: '', 回复: [] },
      ],
    }), 'utf8')
    const 段 = 取刚划到(mem)
    const 没读那句 = 段.split('\n').find((l) => l.includes('没点开')) || ''
    assert.ok(没读那句.includes('真的只看到标题'), '没点开那句要留下真没读的')
    assert.doesNotMatch(没读那句, /二手短视频/, '读过的帖子被列进了「没点开」')
    assert.doesNotMatch(没读那句, /熬夜了又睡不着/, '读过的帖子被列进了「没点开」')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('J8 读过的帖子最多摆两条，其余不丢事实也不刷屏', () => {
  const mem = mkdtempSync(join(tmpdir(), 't692-'))
  try {
    const 最近 = []
    for (let i = 1; i <= 4; i += 1) {
      最近.push({ id: String(i), 标题: `第${i}条有正文`, 正文: `这是第${i}条的正文内容`, 回复: [] })
    }
    writeFileSync(join(mem, '刷手机.json'), JSON.stringify({ at: Date.now(), 平台: '贴吧', 最近 }), 'utf8')
    const 段 = 取刚划到(mem)
    assert.match(段, /第1条有正文/)
    assert.match(段, /第2条有正文/)
    assert.doesNotMatch(段, /第4条有正文/)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})
