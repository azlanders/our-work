const parse = (value) => {
  const text = String(value ?? '').trim()
  const ms = Date.parse(text.includes('T') ? text : text.replace(' ', 'T') + '+08:00')
  return Number.isFinite(ms) ? ms : 0
}

export function 该去的班(班次, now = Date.now(), 提前分钟 = 30) {
  if (!Array.isArray(班次)) return null
  let best = null
  for (const b of 班次) {
    if (!b || ['完成', '缺勤', '辞退'].includes(String(b.状态))) continue
    const start = parse(b.起), end = parse(b.止)
    if (!start || !end || now >= end || now < start - 提前分钟 * 60000) continue
    const 急 = now >= start ? 0 : 1
    if (!best || 急 < best.急 || (急 === best.急 && start < parse(best.起))) best = { ...b, 急 }
  }
  return best
}

export function 该赴的班(班次, 资产 = {}, now = Date.now(), 提前分钟 = 30) {
  const 班 = 该去的班(班次, now, 提前分钟)
  const 目标 = String(班?.点 || '')
  const 在途 = 资产?.在途
  if (!班 || !目标 || (在途 && Number(在途.arriveAt) > now) || String(资产?.位置 || '') === 目标) return null
  return { ...班, 去哪: 目标 }
}

export function 该有的班(配置, 日期, 星期, 已有班次 = []) {
  const 出 = []
  let 日间班已排 = false
  for (const [活, c] of Object.entries(配置?.活 || {})) {
    const 排 = Array.isArray(c.周) ? c.周 : []
    if (!排.length || !排.includes(星期)) continue
    const 起分 = 分钟(c.起), 止分 = 分钟(c.止)
    const 跨夜 = 止分 <= 起分
    const 止日 = 跨夜 ? 次日(日期) : 日期
    if (!跨夜 && 日间班已排) continue
    if (!跨夜 && 起分 < 12 * 60) {
      const 昨日夜班 = (Array.isArray(已有班次) ? 已有班次 : []).some((b) => {
        if (!b) return false
        const start = String(b.起 || '')
        const end = String(b.止 || '')
        const startDay = start.slice(0, 10)
        const startMin = 分钟(start.slice(11, 16))
        const endMin = 分钟(end.slice(11, 16))
        return startDay === 前日(日期) && end.slice(0, 10) === 日期 && endMin <= startMin
      })
      if (昨日夜班) continue
    }
    出.push({
      id: 活 + '-' + 日期.replace(/-/g, '') + '-' + String(c.起).replace(':', ''),
      活, 点: String(c.点 || ''), 起: 日期 + ' ' + c.起, 止: 止日 + ' ' + c.止,
      时薪: Number(c.时薪) || 0, 睡岗每分钟: Number(c.睡岗每分钟) || 0.02,
      状态: '待上', 打卡At: '', 在岗分钟: 0, 扣: 0, 睡岗次数: 0, 记迟到: 0, 记: [],
    })
    if (!跨夜) 日间班已排 = true
  }
  return 出
}

function 分钟(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
function 次日(date) {
  return new Date(Date.parse(date + 'T00:00:00+08:00') + 86400000 + 8 * 3600000).toISOString().slice(0,10)
}
function 前日(date) {
  return new Date(Date.parse(date + 'T00:00:00+08:00') - 86400000 + 8 * 3600000).toISOString().slice(0,10)
}
