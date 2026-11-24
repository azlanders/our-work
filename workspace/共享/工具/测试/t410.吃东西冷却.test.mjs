// t410 —— 吃东西失败后的冷却（批次405）
//
// 病根：`自主行动.mjs` 的 __急饿 里那段冷却只认 `state === '吃点东西'`，
// 而**失败那条日志的 state 是「吃东西失败」**（reportedAction 那行这么写的）。
// 于是注释里那句「防『吃失败还每分钟重试』」从来没生效：
// 失败 → 冷却看不见 → __急饿 又不受 nextAt 限制 → 下一分钟绕回来再试。
//
// 实测：2026-11-11 19:13~19:19 她在图书馆，连着 7 分钟撞「汉堡套餐买不到」；
// 11-13 01:45/01:51、11-14 01:42/04:15 又各来一次。
//
// 修法：整段搬进 `自主判据.mjs` 的 `吃东西冷却中()`，失败也冷却 5 分钟
// （跟日志里那句「5 分钟后再试」对上），并且可注入「现在」——能测。
//
// 这个文件锁：
//   N1 吃到了：30 分钟冷却；「买回来还没吃」只等 10 分钟
//   N2 没买成：**5 分钟冷却**（这条是这批修的）
//   N3 别的东西不影响（喝水失败/摸鱼/脏时间/未来时间）
//   N4 自主行动 真的改成调它了，旧那套写法没留
//
// 跑法：node --test t410.吃东西冷却.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 读 = (p) => readFileSync(p, 'utf8')

let 吃东西冷却中
test('N0 加载', async () => {
  吃东西冷却中 = (await import(join(TOOLS, '自主判据.mjs'))).吃东西冷却中
  assert.equal(typeof 吃东西冷却中, 'function', '自主判据.mjs 没导出 吃东西冷却中')
})

// 日志里的 at 是北京时间的 "YYYY-MM-DD HH:MM:SS"
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 现在 = Date.parse('2026-11-14T05:00:00+08:00')
const 分前 = (n) => 北京(现在 - n * 60e3)
const 跑 = (log, opt = {}) => 吃东西冷却中({ 行动日志: log, 现在, ...opt })

test('N1 吃到了：30 分钟；「买回来还没吃」只等 10 分钟', () => {
  assert.equal(跑([{ at: 分前(5), state: '吃点东西' }]), true, '刚吃完 5 分钟该冷着')
  assert.equal(跑([{ at: 分前(40), state: '吃点东西' }]), false, '40 分钟前吃的，不冷了')
  assert.equal(跑([{ at: 分前(8), state: '吃点东西', note: '买了早饭还没吃' }]), true,
    '买回来还没吃只等 10 分钟 —— 饭就在家里，下一轮就该吃')
  assert.equal(跑([{ at: 分前(15), state: '吃点东西', note: '买了早饭还没吃' }]), false)
})

test('N2 没买成也要冷却 5 分钟（这批修的：原来这条根本不算）', () => {
  assert.equal(跑([{ at: 分前(3), state: '吃东西失败' }]), true, '3 分钟前刚失败，别马上再试')
  assert.equal(跑([{ at: 分前(6), state: '吃东西失败' }]), false, '过了 5 分钟可以再试')
  assert.equal(跑([{ at: 分前(30), state: '吃东西失败' }]), false)
  // 失败条目被后面的日志挤到很后面，也要认得（batch 用 slice(-20)，够用）
  const 多 = [{ at: 分前(3), state: '吃东西失败' },
    ...Array.from({ length: 10 }, (_, i) => ({ at: 分前(2), state: '摸鱼' + i }))]
  assert.equal(跑(多), true, '失败条目在 8 条之前也要认得')
  // 吃到与失败并存时，任一命中就冷着
  assert.equal(跑([{ at: 分前(40), state: '吃点东西' }, { at: 分前(3), state: '吃东西失败' }]), true)
})

test('N3 别的东西不该互相影响', () => {
  assert.equal(跑([{ at: 分前(3), state: '喝水失败' }]), false, '喝水失败不该让吃饭冷着')
  assert.equal(跑([{ at: 分前(2), state: '摸鱼' }]), false)
  assert.equal(跑([]), false, '空日志')
  assert.equal(吃东西冷却中({ 行动日志: null, 现在 }), false, '不是数组')
  assert.equal(跑([{ at: '不知道几点', state: '吃东西失败' }]), false, '脏时间 → 当作没冷却')
  assert.equal(跑([{ at: 北京(现在 + 10 * 60e3), state: '吃东西失败' }]), false,
    '时间在未来（时钟歪了）→ 不当冷却，别把她饿死')
})

test('N4 冷却分钟可调（失败冷却单独一个数）', () => {
  assert.equal(跑([{ at: 分前(10), state: '吃东西失败' }], { 失败冷却分钟: 15 }), true)
  assert.equal(跑([{ at: 分前(10), state: '吃东西失败' }], { 失败冷却分钟: 5 }), false)
})

test('N5 自主行动 真的改成调它了，旧写法没留', () => {
  const 源 = 读(join(TOOLS, '自主行动.mjs'))
  // 批次569 修：原来钉死「, 吃东西冷却中 } from ...」—— 同一个 import 里多一个符号就红，
  // 而那次改动跟这条用例毫不相干（t563 A3 同源）。要锁的是「从 自主判据 引入了它」。
  assert.ok(/import \{[^}]*吃东西冷却中[^}]*\} from '\.\/自主判据\.mjs'/.test(源), '没 import 吃东西冷却中')
  assert.ok(/if \(吃东西冷却中\(\{ 行动日志: aut\.log, 现在: Date\.now\(\) \}\)\) return ''/.test(源),
    '冷却段没改成调函数')
  assert.ok(!/filter\(\(x\) => String\(x\.state \|\| ''\) === '吃点东西'\)/.test(源),
    '旧的「只认吃点东西」那段还在，两套会打架')
})

test('N6 「吃东西失败」这个 state 名字不能单方面改', () => {
  // 吃东西冷却中() 是按这个字符串认失败条目的；同理「喝水失败」被 饮水冷却中() 认。
  // 要改名就得两处一起改 —— 这条钉在这里，免得下次又出现「改了一边、另一边静默失效」。
  const 源 = 读(join(TOOLS, '自主行动.mjs'))
  assert.ok(/reportedAction = foodFailed \? '吃东西失败'/.test(源),
    'foodFailed 的 state 不再是「吃东西失败」—— 改名必须同步改 自主判据.吃东西冷却中')
  assert.ok(/drinkFailed \? '喝水失败'/.test(源),
    'drinkFailed 的 state 不再是「喝水失败」—— 改名必须同步改 自主判据.饮水冷却中')
})
