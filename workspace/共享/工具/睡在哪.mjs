// 睡在哪.mjs —— 她困了，该不该先回家
//
// 批次107（2026-11-06）：主人问「为什么他还在便利店 显示在床上睡着了」。
// 00:20 `自动作息.mjs` 判到 `energy=4`（干完 6 小时夜班），触发强制睡：
// `startSleep()` 只写 `睡醒.json`，`资产.位置` 一动没动，还是 21:49 的便利店。
// 于是面板写着「她现在在便利店」+「在床上睡着了」，QQ 状态写着「睡着了」。
//
// 一个人不会「在便利店床上睡」。睡觉这件事得先在家 —— 本条只管
// 「要不要先走一趟」，走不走得成、走多久归 `走路.mjs`；睡不睡归 `自动作息.mjs`。
//
// 抽成纯函数是因为 `自动作息.mjs` 一被 import 就会执行整个脚本（它要真的睡觉），
// 逻辑埋在里面就只能靠 `--dry` 看打印，验不到「三更半夜人在外面」这种边界。
import { readFileSync } from 'node:fs'

/**
 * 判断睡觉前要不要先回家。
 * @param {{位置?: string, 在途?: {to?: string, arriveAt?: number}}} 资产
 * @param {number} now
 * @returns {{走: boolean, 位: string, 在路上: boolean, 去哪: string, 话: string}}
 */
export function 睡在哪(资产, now = Date.now()) {
  const 位 = String((资产 && 资产.位置) || '家')
  const 途 = 资产 && 资产.在途
  const 在路上 = !!(途 && 途.to && Number(途.arriveAt) > Number(now))

  if (在路上) {
    const 去哪 = String(途.to || '')
    return {
      走: false,
      位,
      在路上: true,
      去哪,
      // 已经在往家走了就别再喊一次 —— 半路开始睡才是真的怪
      话: 去哪 === '家' ? '正在往家走的路上，到了再睡' : '正在去' + 去哪 + '的路上，到了再说',
    }
  }
  if (位 === '家') {
    return { 走: false, 位, 在路上: false, 去哪: '', 话: '' }
  }
  return {
    走: true,
    位,
    在路上: false,
    去哪: '',
    话: '困了，但人在' + 位 + ' —— 先往家走，到了再睡',
  }
}

/** 从记忆目录读资产再判一次；读不到当「在家」，不因为读文件失败就不让她睡。 */
export function 读资产再判(base, now = Date.now()) {
  try {
    const a = JSON.parse(readFileSync(String(base) + '/资产.json', 'utf8'))
    return 睡在哪(a, now)
  } catch {
    return { 走: false, 位: '家', 在路上: false, 去哪: '', 话: '' }
  }
}
