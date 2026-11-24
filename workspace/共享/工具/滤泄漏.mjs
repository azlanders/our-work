// 滤泄漏.mjs —— 在 SSE 流里把「模型推演被当成正文」的 text 块内容丢掉。
//
// 背景（批次372，2026-11-13）：上游偶尔会把思考内容同时写进 thinking 块和 text 块，
// 宿主把 text 当正文记下、插件照发，主人看到一整段英文。
//
// 判据：text 块开头 80 字符里一个中文都没有 —— 她对中文用户说话不会这样开头。
//
// HEURISTIC_COST 2026-11-24：**这条判据有已知代价，写在这里别忘**：
//   · 她如果真在用英文回答（主人拿英文问她、或她读英文材料后转述），
//     这块合法正文会被当推演丢掉 —— 症状是「她明明回了，但手机上什么都没有」。
//   · 判据只对「这一块**开头** 80 字」生效，所以中英混排（中文在后）不会被误杀。
//   · 想临时关掉：{{DSH_ROOT}}/fish-leak.json 里 `过滤推演块: false`（不用重启）。
// 之所以还是保留：2026-11-13 那两轮「一个字都没发出去」比误杀英文更严重 ——
// 前者是她完全不工作，后者只是某几句不理想。
// 处理：把这一整块的 text_delta 丢掉，但 content_block_start / stop 照发，
//      保证 index 连续（丢掉整个块会让宿主看到 0,2,3 这种断号）。
//
// 没判定出结果之前，delta 帧先压在手里不往下发（最多压 80 字符的量）。

import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync } from 'node:fs'

const 门槛 = 80
const 开关文件 = '{{DSH_ROOT}}/fish-leak.json'

/**
 * 关思考开关。默认 true —— 2026-11-13 20:14 / 20:33 两轮她一个字都没发出去，
 * 原因是上游把 thinking 内容同时写进 text 块，模型以为已经回过就 end_turn。
 * 出闸拦、接口丢块都只能删内容，治不了「她不行动」。
 */
export function 关思考(路径 = 开关文件) {
  try {
    const j = JSON.parse(readFileSync(路径, 'utf8'))
    return j && j.关闭思考 !== false
  } catch {
    return true
  }
}

/**
 * 接口层的开关。改完不用重启，下一个请求就按新值走。
 *   { "过滤推演块": false }  → 关掉过滤，恢复纯透传
 * 文件不存在或读不动，默认「开」—— 泄漏比延迟更难受。
 */
export function 开过滤(路径 = 开关文件) {
  try {
    const j = JSON.parse(readFileSync(路径, 'utf8'))
    return j && j.过滤推演块 !== false
  } catch {
    return true
  }
}

/** 这段文本像不像模型的英文推演。她对主人说话不会是 20 字以上纯外文。 */
export function 像推演(s) {
  const 中文字 = (s.match(/[\u4e00-\u9fff]/g) || []).length
  if (中文字 >= 2) return false
  return s.length >= 12
}

export function 造滤流(记 = () => {}) {
  const 解 = new StringDecoder('utf8')
  let 尾 = ''
  const 块 = new Map()
  const 统计 = { 丢块: 0, 丢字符: 0, 放行块: 0 }

  const 处理帧 = (段, out) => {
    const 行s = 段.split('\n')
    const d行 = 行s.find((l) => l.startsWith('data:'))
    if (!d行) return out(段)
    let j
    try {
      j = JSON.parse(d行.slice(5).trim())
    } catch {
      return out(段)
    }
    const t = j && j.type

    if (t === 'content_block_start') {
      块.set(j.index, { 是文本: j.content_block && j.content_block.type === 'text', 判了: false, 丢: false, buf: '', 压: [] })
      return out(段)
    }

    if (t === 'content_block_delta') {
      const 状 = 块.get(j.index)
      const d = j.delta || {}
      if (!状 || !状.是文本 || d.type !== 'text_delta') return out(段)
      if (状.丢) { 统计.丢字符 += String(d.text || '').length; return }   // 整帧不发
      if (状.判了) return out(段)
      状.buf += String(d.text || '')
      状.压.push(段)
      if (状.buf.length >= 门槛) {
        if (像推演(状.buf)) {
          状.丢 = true; 状.判了 = true
          统计.丢块 += 1; 统计.丢字符 += 状.buf.length
          记({ 事: '滤掉推演块', 字符: 状.buf.length, 开头: 状.buf.slice(0, 60) })
          状.压 = []
        } else {
          状.判了 = true; 统计.放行块 += 1
          for (const f of 状.压) out(f)
          状.压 = []
        }
      }
      return
    }

    if (t === 'content_block_stop') {
      const 状 = 块.get(j.index)
      if (状 && 状.是文本 && !状.判了) {
        if (像推演(状.buf)) {
          状.丢 = true; 统计.丢块 += 1; 统计.丢字符 += 状.buf.length
          记({ 事: '滤掉短推演块', 字符: 状.buf.length, 开头: 状.buf.slice(0, 60) })
        } else {
          统计.放行块 += 1
          for (const f of 状.压) out(f)
        }
        状.判了 = true; 状.压 = []
      }
      return out(段)
    }

    return out(段)
  }

  const 流 = new Transform({
    transform(chunk, enc, cb) {
      try {
        尾 += 解.write(chunk)
        const 段s = 尾.split('\n\n')
        尾 = 段s.pop()
        for (const 段 of 段s) 处理帧(段, (s) => 流.push(s + '\n\n'))
        cb()
      } catch (e) {
        cb(e)
      }
    },
    flush(cb) {
      try {
        尾 += 解.end()
        if (尾.trim()) 处理帧(尾, (s) => 流.push(s))
        cb()
      } catch (e) {
        cb(e)
      }
    },
  })
  流.统计 = 统计
  return 流
}
