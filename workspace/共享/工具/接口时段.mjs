export const 峰谷候选ID = 'kmwmfwa8n'
export const 休假依据 = '国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号）'
const 休假 = [
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
]

export function 校验时段(值) {
  if (值?.模式 === '不限') return { 模式: '不限' }
  if (值?.模式 === '谷期') return { 模式: '谷期' }
  const 时分 = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (值?.模式 === '每日' && typeof 值.开始 === 'string' && typeof 值.结束 === 'string'
    && 时分.test(值.开始) && 时分.test(值.结束) && 值.开始 !== 值.结束) {
    return { 模式: '每日', 开始: 值.开始, 结束: 值.结束 }
  }
  return null
}

export function 候选时段(候选) {
  if (!Object.hasOwn(候选 ?? {}, '时段')) return { 模式: '不限' }
  return 校验时段(候选.时段)
}

/** 北京时间现在是不是 DeepSeek 谷期。峰谷只影响价格，不再决定能不能用。 */
export function 谷期(现在 = Date.now()) {
  const 北京 = new Date(现在 + 8 * 3600e3)
  const 日期时间 = 北京.toISOString()
  const 时分 = 日期时间.slice(11, 16)
  const 星期 = 北京.getUTCDay()
  if (星期 === 0 || 星期 === 6) return true
  const 日期 = 日期时间.slice(5, 10)
  if (北京.getUTCFullYear() === 2026 && 休假.some(([首日, 末日]) => 首日 <= 日期 && 日期 <= 末日)) return true
  return !(时分 >= '09:00' && 时分 < '12:00' || 时分 >= '14:00' && 时分 < '18:00')
}

export function 时段可用(时段, 现在 = Date.now()) {
  if (!时段) return false
  if (时段.模式 === '不限') return true
  if (时段.模式 === '每日') {
    const 时分 = new Date(现在 + 8 * 3600e3).toISOString().slice(11, 16)
    const { 开始, 结束 } = 时段
    return 开始 < 结束 ? 开始 <= 时分 && 时分 < 结束 : 开始 <= 时分 || 时分 < 结束
  }
  if (时段.模式 !== '谷期') return false
  return 谷期(现在)
}

/** 未标倍率的钥匙按 1x 算，避免老配置突然排到最前面。 */
export function 基础倍率(候选) {
  const n = 候选?.倍率 == null ? NaN : Number(候选.倍率)
  return Number.isFinite(n) && n >= 0 ? n : 1
}

/** 当前时刻真正参与路由的价格倍率。谷期只对开了峰谷的钥匙生效。 */
export function 有效倍率(候选, 现在 = Date.now()) {
  const 基 = 基础倍率(候选)
  if (候选?.峰谷 !== true) return 基
  const 峰 = 候选?.峰倍率 == null ? NaN : Number(候选.峰倍率)
  const 峰倍 = Number.isFinite(峰) ? 峰 : 基
  const 谷 = 候选?.谷倍率 == null ? NaN : Number(候选.谷倍率)
  const 谷倍 = Number.isFinite(谷) ? 谷 : 峰倍 / 2
  return 谷期(现在) ? 谷倍 : 峰倍
}

export function 凭证可用(候选, key, 现在 = Date.now()) {
  return Array.isArray(候选) && 候选.every((项) => !项?.key || String(项.key).trim() !== String(key).trim()
    || 时段可用(候选时段(项), 现在))
}
