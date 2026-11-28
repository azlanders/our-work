// 真实对话向的新行为：画像、情绪降温、事实句、未了的事、近似重复折叠、指代路由。
// 这些用例测的是"聊天里会发生什么"，不是基准分数。
import test from 'node:test'
import assert from 'node:assert/strict'

import { toneOf } from '../dsh/vendor/dsh-mnemonic/lib/tone.js'
import { profileSlots, renderProfile, slotOf, stableAttrOf } from '../dsh/vendor/dsh-mnemonic/lib/profile.js'
import { factSentences, factKeywords } from '../dsh/vendor/dsh-mnemonic/lib/facts.js'
import { openLoops, renderOpenLoops } from '../dsh/vendor/dsh-mnemonic/lib/openloops.js'
import { renderRecallBlock } from '../dsh/vendor/dsh-mnemonic/lib/card.js'
import { boundaryOf, renderBoundaries } from '../dsh/vendor/dsh-mnemonic/lib/boundary.js'
import { isChitChat, isMetaRecall, isMultiNeedQuery, isLowValueOrInjection } from '../dsh/vendor/dsh-mnemonic/lib/text.js'

const DAY = 86400000
const now = Date.parse('2026-11-28T21:00:00+08:00')
const rec = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2, 8),
  text: over.text || '用户：我在便利店上班\n我：嗯嗯',
  scope: 'private:1',
  eventAt: over.eventAt || now - DAY,
  createdAt: over.eventAt || now - DAY,
  importance: 0.35,
  source: { kind: 'auto' },
  ...over,
})

test('toneOf 只标负面事件，日常陈述不算', () => {
  assert.equal(toneOf('用户：我妈住院了\n我：要紧吗'), 'neg')
  assert.equal(toneOf('用户：我在便利店上班\n我：辛苦'), '')
  assert.equal(toneOf('我：今天好难过'), '', '助手的话不算事件')
})

test('画像只收本 scope、跳过临时状态和伤口、旧值让位给新值', () => {
  const records = [
    rec({ id: 'a', text: '用户：我在便利店上班\n我：嗯', eventAt: now - 30 * DAY }),
    rec({ id: 'b', text: '用户：我在公司加班\n我：早点睡', eventAt: now - 2 * DAY }),
    rec({ id: 'c', text: '用户：我妈住院了\n我：要紧吗', eventAt: now - DAY }),
    rec({ id: 'd', text: '用户：我叫沈知夏\n我：记住了', eventAt: now - 10 * DAY }),
    rec({ id: 'e', text: '用户：我叫小明\n我：好', eventAt: now - 40 * DAY, supersededBy: 'd', validTo: now - 10 * DAY }),
    rec({ id: 'f', text: '用户：我在上学\n我：嗯', scope: 'private:2', eventAt: now - DAY }),
  ]
  const slots = profileSlots(records, ['private:1'])
  const bySlot = Object.fromEntries(slots.map((s) => [s.slot, s.value]))
  assert.equal(bySlot['称呼'], '沈知夏')
  assert.ok(!JSON.stringify(bySlot).includes('住院'), '伤口不进画像')
  assert.ok(!JSON.stringify(bySlot).includes('上学'), '别人 scope 不进画像')
  const text = renderProfile(slots)
  assert.ok(text.includes('【长期印象】'), text)
})

test('stableAttrOf 不把加班、出差当成改职业', () => {
  assert.equal(stableAttrOf(rec({ text: '用户：我在公司加班' })), '')
  // 「我换工作了」是明确变更，要能覆盖旧职业；「加班」只是当天状态。
  assert.equal(stableAttrOf(rec({ text: '用户：我换工作了' })), '工作')
  assert.equal(stableAttrOf(rec({ text: '用户：我换工作了，现在在便利店上夜班' })), '工作')
  assert.equal(stableAttrOf(rec({ text: '用户：我在便利店上班' })), '工作')
  assert.equal(stableAttrOf(rec({ text: '用户：我在便利店上夜班' })), '工作')
  assert.equal(stableAttrOf(rec({ text: '用户：我叫沈知夏' })), '称呼')
})

test('事实句只抽用户那半段，问句和寒暄不抽', () => {
  const facts = factSentences('用户：我在便利店上班，最近换到夜班了。你呢？\n我：我还好')
  assert.equal(facts.length, 1, facts.join('|'))
  assert.ok(facts[0].includes('便利店'))
  assert.deepEqual(factSentences('用户：在吗\n我：在'), [])
  assert.deepEqual(factSentences('用户：你是不是傻\n我：…'), [])
  assert.ok(factKeywords(facts).length > 0)
})

test('未了的事能认出约定，渲染不超过预算', () => {
  const records = [
    rec({ id: 'p', text: '用户：明天告诉你面试结果\n我：好', eventAt: now - DAY }),
    rec({ id: 'q', text: '用户：回头聊这个\n我：嗯', eventAt: now - 2 * DAY }),
    rec({ id: 'r', text: '用户：明天要下雨\n我：带伞', eventAt: now - DAY }),
  ]
  const items = openLoops(records, { scopes: ['private:1'], now })
  const texts = items.map((i) => i.text)
  assert.ok(texts.some((t) => t.includes('面试结果')), texts.join('|'))
  assert.ok(!texts.some((t) => t.includes('下雨')), '天气预报不是约定')
  const line = renderOpenLoops(items, { maxChars: 90, now })
  assert.ok(line.length <= 90, line)
  assert.ok(line.includes('面试结果') || line.includes('回头聊'), line)
})

test('同一句换说法只渲染一次，原文仍可查', () => {
  const a = rec({ id: 'a', text: '用户：我在便利店上班\n我：嗯', eventAt: now - 3 * DAY })
  const b = rec({ id: 'b', text: '用户：我在便利店上班呢\n我：好', eventAt: now - DAY, canonicalId: 'a' })
  const block = renderRecallBlock([{ rec: a, score: 2 }, { rec: b, score: 1 }], { maxChars: 600, itemChars: 120, now })
  const hits = (block.match(/便利/g) || []).length
  assert.equal(hits, 1, block)
})

test('渲染只回报真正进块的条目', () => {
  const seen = []
  const hits = [
    { rec: rec({ id: 'a', text: '用户：第一件事\n我：嗯' }), score: 2 },
    { rec: rec({ id: 'b', text: '用户：第二件事\n我：嗯' }), score: 1 },
  ]
  renderRecallBlock(hits, { maxChars: 200, itemChars: 20, now, onRender: (id) => seen.push(id) })
  assert.ok(seen.length >= 1)
  assert.ok(seen.length <= 2)
})

test('指代路由：点名了东西就正常检索，只有「那个事」才走最近记录', () => {
  assert.equal(isMetaRecall('你还记得我上次说的那个事吗'), true)
  assert.equal(isMetaRecall('我上次说的那个电影叫啥'), false)
  assert.equal(isChitChat('晚安'), true)
  assert.equal(isChitChat('我换工作了'), false)
  assert.equal(isMultiNeedQuery('我今天买了几件衣服'), false)
  assert.equal(isMultiNeedQuery('要带什么？'), true)
})

test('短句里的自述转折不再被当垃圾丢掉', () => {
  assert.equal(isLowValueOrInjection('我换工作了'), false)
  assert.equal(isLowValueOrInjection('对不起'), true)
})

test('口语回溯和日常句不会污染画像', () => {
  // P0：「我叫啥来着」是回溯，不是报名字；判成定义式会把真名字作废。
  assert.equal(stableAttrOf(rec({ text: '用户：我叫啥来着' })), '')
  assert.equal(slotOf(rec({ text: '用户：我叫啥来着' })), '')
  assert.equal(stableAttrOf(rec({ text: '用户：我叫了个外卖' })), '')
  // 当天作息是临时状态，不能作废「每天几点睡」。
  assert.equal(stableAttrOf(rec({ text: '用户：我今天10点睡的' })), '')
  assert.equal(stableAttrOf(rec({ text: '用户：我每天十一点睡' })), '作息')
  // 「我大学同学」不是职业。
  assert.equal(slotOf(rec({ text: '用户：我大学同学结婚了' })), '')
})

test('婉拒和保密句不算未了约定', () => {
  const records = [
    rec({ id: 'w', text: '用户：这事儿回头再说吧' }),
    rec({ id: 's', text: '用户：我明天去医院，别告诉别人' }),
  ]
  assert.equal(openLoops(records, { scopes: ['private:1'], now }).length, 0)
})

test('今晚的到期时间落在当天晚上，不是次日凌晨', () => {
  const anchor = Date.parse('2026-11-28T10:00:00+08:00')
  const r = rec({ id: 'n', text: '用户：今晚告诉你结果', eventAt: anchor })
  const [item] = openLoops([r], { scopes: ['private:1'], now: anchor })
  assert.ok(item, '今晚说的话要算未了约定')
  const d = new Date(item.dueAt + 8 * 3600000)
  assert.equal(d.getUTCDate(), 28, 'dueAt 应在当天')
  assert.equal(d.getUTCHours(), 20, 'dueAt 应在北京时间 20:00')
})

test('边界只认祈使的约束，安慰和操作指令都不算', () => {
  assert.equal(boundaryOf('别叫我宝贝'), '叫我宝贝')
  assert.equal(boundaryOf('以后别在晚上给我发消息'), '在晚上给我发消息')
  assert.equal(boundaryOf('别担心'), '')
  assert.equal(boundaryOf('别客气啦'), '')
  assert.equal(boundaryOf('别记这个'), '')
  assert.equal(boundaryOf('别老提这个'), '')
  assert.equal(boundaryOf('你别生气了好不好'), '', '问句不是约束')
})

test('边界进常驻段：去重、跳过静音与作废、守住预算', () => {
  const records = [
    rec({ id: 'b1', text: '用户：别叫我宝贝\n我：好', boundary: '叫我宝贝', createdAt: now }),
    rec({ id: 'b2', text: '用户：别叫我宝贝\n我：知道了', boundary: '叫我宝贝', createdAt: now - 1000 }),
    rec({ id: 'b3', text: '用户：别提我妈\n我：嗯', boundary: '提我妈', createdAt: now - 2000 }),
    rec({ id: 'b4', text: '用户：别熬夜\n我：好', boundary: '熬夜', createdAt: now - 3000, muted: true }),
    rec({ id: 'b5', text: '用户：别抽烟\n我：好', boundary: '抽烟', createdAt: now - 4000, supersededBy: 'x' }),
  ]
  const line = renderBoundaries(records, { maxChars: 70, limit: 3 })
  assert.equal((line.match(/别叫我宝贝/g) || []).length, 1, line)
  assert.ok(line.includes('别提我妈'), line)
  assert.ok(!line.includes('熬夜'), '静音的不进常驻段')
  assert.ok(!line.includes('抽烟'), '作废的不进常驻段')
  assert.ok(line.length <= 70, line)
  assert.equal(renderBoundaries([], {}), '')
})
