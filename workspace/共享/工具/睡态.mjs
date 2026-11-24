// 睡态.mjs —— 「她是不是在睡」只在这里回答一次。
//
// 批次164 审计量到：22 个脚本读睡眠，判据有五种写法：
//   flag.sleeping === true            睡醒.json          （缺口/自主行动/计划/自拍/资产/活动/面板…）
//   睡眠.sleeping === true            睡眠.json          （投递留言.mjs 这么读；房间.mjs 已于 2026-11-24 归档）
//   Boolean(睡眠.live)                睡眠.json 的段
//   Boolean(live) || flag.sleeping    状态推进 / 自动作息 / 工作（已经自己合过一次）
//   flag.sleeping !== true            家区域（反着写）
//
// 两套标记各有各的复位路径，任一条漏掉就分叉：
//   · endSleep 先写 睡眠.json（sleeping=false, live=null）再 writeFlag(false)，
//     后者被 try/catch 吞掉 → 睡醒.json 永远挂着 true，人却已经醒了；
//   · 醒来.mjs 的「已经醒了（没有在睡记录）」分支只把 睡醒.json 扶正，不动 睡眠.json；
//   · endSleep 整段抛异常时，睡眠.json 的 sleeping/live 和 睡醒.json 会各留一半。
// 分叉的实际后果不是「显示错了」：曾经的 房间.mjs 说她在睡（不给她开灯/做饭）——
// 那个服务已归档，但分叉本身仍可能出现在别的读方，判据必须收口。
// 自主行动 说她醒着（照样抽签搬她走）—— 主人看到的就是「叫不醒」或者「说睡了还在动」。
//
// 判据（记忆里那条「睡着看标记不看钟点」）：
//     睡醒.json.sleeping === true   或   睡眠.json.live 存在
// 两个都是「这一觉还没结束」的证据，任一亮着就算睡。
// 不看 睡眠.json.sleeping —— 它和 live 同生共死，而 endSleep 的注释自己写着
// 「以 live 为准：sleeping 可能被别的路径先改掉」，看 live 就够，少一个会分叉的字段。
//
// 打盹不算睡着：短睡不写 睡醒.json（会清零清醒时长、还会被记成一觉），
// 也不开睡眠段，只写 打盹.json。要问「是不是在打盹」用 打盹中()。

import { join } from 'node:path'
import { 读档, 解析北京 } from './_底层.mjs'

/** 不传目录时的默认值。生产只有这一个；沙盒请把调用方自己的 MEM 传进来。 */
export const 默认记忆 = '{{BOT_ROOT}}/记忆'

const 取目录 = (d) => (typeof d === 'string' && d ? d : 默认记忆)

/** 睡醒.json 原样。它是「睡着/醒着」的权威标记，也是 困意.mjs 算清醒时长的起点。 */
export function 睡醒标记(目录) {
  return 读档(join(取目录(目录), '睡醒.json'), { sleeping: false, since: '' })
}

/** 正在开着的那一段睡眠（睡眠阶段.mjs 的 live）。没有就返回 null。 */
export function 睡眠段(目录) {
  const s = 读档(join(取目录(目录), '睡眠.json'), {})
  return s && s.live && typeof s.live === 'object' ? s.live : null
}

/**
 * 她睡着了吗。门控一律问这个，别再各自读文件。
 *
 * 三级：标记说 true → 睡；标记说 false → 醒（**明确表态就信它**）；
 * 标记压根不在（首次运行 / 文件被删）→ 退回去看睡眠段还开不开着。
 *
 * 中间那一档是关键。把 false 也当成「再看看段」的话，endSleep 抛异常、
 * 作息 已经把她扶正成醒着的场景里，段还挂着 live —— 人明明醒了，
 * 所有门控却一起说她在睡，那就成了我自己造的「叫不醒」。
 * 反过来，标记说 false 就放行，是原来的行为（缺口/自主行动一直是这么读的），不改。
 */
export function 睡着(目录) {
  const 标记 = 读档(join(取目录(目录), '睡醒.json'), null)
  // ARRAY_GUARD 2026-11-13（批次373）：数组也是 object。睡醒.json 万一被写成 []，
  // 原来会被当成「明确表态醒着」，人真睡着也永远判醒 —— 跟「叫不醒」是同一类事故。
  // 同一个代码库的 proactive.loadTable 就明确排除了 Array，这里原来漏了。
  if (标记 && typeof 标记 === 'object' && !Array.isArray(标记)) return 标记.sleeping === true
  return Boolean(睡眠段(目录))
}

/**
 * 打盹的到点毫秒（纯函数，拿不到返回 0）。**这个判据只有这一份。**
 *
 * NAP_END_PARSE 2026-11-16（批次559）：原来 打盹中() 读 `到毫秒 || 解析北京(到)`，
 * 而 `打盹.mjs --tick` 只认 `到`、而且只认 16 字符的 `YYYY-MM-DD HH:MM` ——
 * 同一个 打盹.json，一处说「还在打盹」、一处说「必须醒」。
 * 更糟的是 `--tick` 拿到 NaN 会**直接删档**：`到` 里多一个 `:00`，她就在第 0 分钟醒了。
 * 现在三级统一：到毫秒 → 到 → 开始 + 分钟。三个都拿不到才算拿不到。
 */
export function 盹到点(n) {
  if (!n || typeof n !== 'object') return 0
  const ms = Number(n['到毫秒'])
  if (Number.isFinite(ms) && ms > 0) return ms
  const 到 = 解析北京(n['到'], 0)
  if (到 > 0) return 到
  const 起 = 解析北京(n['开始'], 0)
  const 分 = Number(n['分钟'])
  if (起 > 0 && Number.isFinite(分) && 分 > 0) return 起 + 分 * 60e3
  return 0
}

/**
 * 睡 / 打盹的地方有多舒服 → 恢复倍率。
 *
 * COMFORT 2026-11-16（批次564）：主人原话「睡眠或者打盹的舒适度，在床上躺着睡觉舒适度高，
 * 各项恢复速度较快，但不能太快」。判据只有这一份 ——
 * `睡眠阶段.tickSleep`（整觉，每分钟）和 `状态推进`（打盹，每小时）都问它。
 * 两处各写一张表就是本项目反复踩的那个分叉，别再来一次。
 */
export function 睡在哪倍率(位) {
  const p = String(位 || '家')
  if (p === '家') return 1.0
  if (['咖啡店', '图书馆', '公园', '学校', '电影院', '澡堂'].includes(p)) return 0.7
  return 0.5
}

/** 正在打盹吗（短睡，不算一觉）。 */
export function 打盹中(目录, now = Date.now()) {
  return 盹到点(读档(join(取目录(目录), '打盹.json'), null)) > now
}


/**
 * 起床气：深睡里被人硬拽起来之后那一小段脾气。
 *
 * WAKE_GRUMP 2026-11-16（批次567）：判据只有一份，写在 `睡眠阶段.endSleep` 里
 * （woken + N3 + 这一觉 >= 60 分钟）。这个函数只负责把状态翻译成**她自己看得懂的事实**，
 * 不是台词 —— 说什么、说不说仍然归她（判断权在她）。
 *
 * 谁 再兜一次白名单：endSleep 已经把 QQ_WAKE_BY 收敛成「主人 / 人」，
 * 这里连脏数据也只吐这两个词（注入里不许出现 8 位裸号，t421 I5）。
 */
export function 起床气话(气, now = Date.now()) {
  if (!气 || typeof 气 !== 'object') return ''
  const 到 = Number(气.untilMs)
  if (!Number.isFinite(到) || 到 <= now) return ''
  const 分 = Math.max(1, Math.round((到 - now) / 60e3))
  const 谁 = String(气.谁 || '') === '主人' ? '主人' : '人'
  return '刚被' + 谁 + '从深睡里硬拽起来，脑袋发沉、火气有点压不住（还有 ' + 分 + ' 分钟才缓过来）'
}

/**
 * 连熬几晚之后，她该知道这是个「作息债」，不是「今天不行」。
 *
 * STRAIN_HINT 2026-11-16（批次568）：只吐事实（几晚、怎么养回来），不给台词。
 * 门槛与封顶都在 恢复目标.结算熬夜，这里不重复判。
 */
export function 熬夜话(账) {
  if (!账 || typeof 账 !== 'object') return ''
  const 天 = Number(账.连续天数)
  if (!Number.isFinite(天) || 天 < 1) return ''
  return '连着 ' + Math.round(天) + ' 晚没睡好（熬到后半夜或睡不够），脑子发糊、白天提不起劲；连着 3 晚睡够才养得回来'
}

/**
 * 调试用：把每个来源分开报。分叉的时候一眼看出是哪一处没复位。
 * `node -e "import('./睡态.mjs').then(m=>console.log(m.判据()))"`
 */
export function 判据(目录, now = Date.now()) {
  const 标记 = 读档(join(取目录(目录), '睡醒.json'), null)
  const 段 = 睡眠段(目录)
  return {
    睡着: 睡着(目录),
    睡醒标记: 标记 && typeof 标记 === 'object' ? Boolean(标记.sleeping) : null,
    标记文件在: Boolean(标记 && typeof 标记 === 'object'),
    睡眠段: Boolean(段),
    段起点: 段 ? String(段.start || '') : '',
    打盹: 打盹中(目录, now),
    标记起点: 标记 && typeof 标记 === 'object' ? String(标记.since || '') : '',
  }
}
