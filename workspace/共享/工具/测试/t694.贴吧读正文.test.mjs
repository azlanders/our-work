// t694 —— 贴吧刷的时候真的点开读正文（批次694）
//
// 起因：11-17 21:04 她刷贴吧只拿到标题，却讲「底下还有一堆人认真分析半天」，
// 21:57 才承认「纯是照标题猜的」。`刷一刷.mjs` 当时只抓标题和时长。
//
// 这一条锁三件事：
//   A 抓到帖子后真的会调 readThread，并把正文写进 刷手机.json（否则注入端拿不到）
//   B 读正文失败不影响这一轮（她照样知道划到了什么），且绝不伪造正文
//   C 关掉开关就不读（省一次请求），正文为空 —— 回到「只划到标题」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.QUIET_NOTE = '1'

const 测试目录 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(测试目录, '..')
const 源码 = readFileSync(join(工具, '刷一刷.mjs'), 'utf8')

test('A1 抓完帖子会调 readThread 读正文', () => {
  assert.match(源码, /mod\.readThread\(条\.id\)/, '刷一刷没有调用 readThread —— 正文永远读不到')
  assert.match(源码, /条\.正文\s*=/, '读到的正文没挂到条目上')
})

test('A2 正文会落进 刷手机.json 的最近，注入端才拿得到', () => {
  assert.match(源码, /正文: t\.正文 \|\| ''/, '刷手机.json 的 最近 没带正文')
  assert.match(源码, /正文: t\.正文 \|\| '', 回复: Array\.isArray\(t\.回复\) \? t\.回复 : \[\], 看过: false/,
    '刷过.jsonl 没带正文或回复')
})

test('A3 读正文失败只记一笔，不算刷失败、也不伪造', () => {
  const i = 源码.indexOf('await mod.readThread')
  const 段 = 源码.slice(i, i + 700)
  assert.match(段, /catch/, 'readThread 没有兜底 —— 一条读不到会把整轮刷手机打挂')
  assert.match(段, /没读到正文/, '读失败没留痕，日志里看不出她到底看没看')
  assert.doesNotMatch(段, /正文\s*=\s*['"]/, '读失败时不许塞假正文')
})

// 手机版有的帖子首楼只有「立即下载客户端」。把它当正文，等于让她讲一段广告占位 ——
// 这是 11-17 那次「照标题编评论」的同型问题，只是换了个来源。
test('A4 「立即下载客户端」这类占位层不能当正文', () => {
  assert.match(源码, /占位层/, '没有占位层过滤')
  const 起 = 源码.indexOf('const 占位层')
  const 段 = 源码.slice(起, 起 + 900)
  assert.match(段, /立即下载客户端/, '占位词表里没有「立即下载客户端」')
  assert.match(段, /continue/, '占位层没被跳过')
})

test('A5 太短的层（如题/RT/顶）不算正文，往后找', () => {
  const 起 = 源码.indexOf('function 挑正文')
  assert.ok(起 > 0, '挑正文 没了')
  const 段 = 源码.slice(起, 起 + 700)
  assert.match(段, /刷_贴吧正文最短/, '没有最短长度门槛')
  assert.match(段, /continue/, '短层没被跳过')
})

// 批次695：主人要求「楼层回复和评论一起读」。readThread 的 floors 本来就含这些层，
// 不额外发请求，只是以前被扔掉了。
test('A6 楼层回复跟正文一起取，并落进 刷手机.json', () => {
  assert.match(源码, /拆\.回复/, '挑正文没返回回复')
  assert.match(源码, /条\.回复 = 拆\.回复/, '回复没挂到条目上')
  assert.match(源码, /回复: Array\.isArray\(t\.回复\) \? t\.回复 : \[\]/, '刷手机.json 没带回复')
})

test('A7 回复条数与每层字数有上限，不会把整帖塞进注入', () => {
  const 起 = 源码.indexOf('function 挑正文')
  const 段 = 源码.slice(起, 起 + 1400)
  assert.match(段, /刷_贴吧回复条/, '回复条数没参数化')
  assert.match(段, /Math\.min\(5,/, '回复条数没有硬上限')
  assert.match(段, /刷_贴吧回复字数/, '每层字数没参数化')
  assert.match(段, /\.slice\(主 \+ 1,/, '回复没有从楼主之后开始取')
})

test('A8 同一层被拆成多个 div 时去重，别把一句说两遍', () => {
  const 起 = 源码.indexOf('function 挑正文')
  const 段 = 源码.slice(起, 起 + 1400)
  assert.match(段, /见过/, '没有去重集合')
  assert.match(段, /见过\.has\(t\)/, '重复层没被跳过')
})

test('B1 关掉开关就不读正文（省一次请求，回到只划标题）', () => {
  assert.match(源码, /刷_贴吧读正文/, '没有开关')
  assert.match(源码, /!== 0 && 抽到\.length > 0/, '开关没真正挡住读取')
})

test('C1 参数与面板都能调', () => {
  const 参 = JSON.parse(readFileSync(join(工具, '参数.json'), 'utf8'))['拟人']
  for (const k of ['刷_贴吧读正文', '刷_贴吧读正文条', '刷_贴吧正文字数', '刷_贴吧正文最短',
    '刷_贴吧回复条', '刷_贴吧回复字数']) {
    assert.ok(Number.isFinite(Number(参[k])), `参数.json 缺 ${k}`)
  }
  const 面板 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  assert.match(面板, /刷_贴吧读正文:贴吧读正文/, '面板里没这个可调项')
})
