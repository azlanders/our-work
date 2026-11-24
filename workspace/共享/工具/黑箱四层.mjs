// LAYERS 2026-11-17（批次669）：黑箱四层视图的纯派生层。
//
// 起因：面板只有「换的顺序 + 所有钥匙」两块平铺 —— 一条候选里同时揉着供应商身份、
// 凭证、上游地址、模型映射和健康状态，「路由」只是一个 id 数组。出问题分不清是
// 供应商挂了、路由没进链、还是网关本身没起来。批次668 那个「只剩官方一条」的事故
// 之所以吓人，就是因为没有层级可对照。
//
// 这里只做**纯函数派生**：输入是面板已经读到的候选钥匙、当前中转配置和 /health，
// 输出四层结构给前端画。不改存储、不改选路、不写盘。
// 结构对齐 magpie 的 provider / route / group / gateway 四层：
//   供应商 = 按 base 归并（空 base = deepseek 官方）；同一家下几把 key 是并列候选，
//            各自冷却、各自配额，所以不合并成一条。
//   路由   = 一条候选（一把 key + 模型映射 + 健康 + 备注）。
//   路由组 = 有序成员链 + 策略。当前只有 `order`（逐个试），字段留着以后加策略。
//   网关   = 中转自己（监听地址、当前指针、兜底）。
//
// 关键约束：`成员` 是 **id 引用**，不是凭证副本 —— 自动切官方只改顺序，永远不删成员。

const 官方 = '（deepseek 官方）'

/**
 * @param {object} o
 * @param {Array} o.候选 面板读到的候选钥匙（已打码，含 id/名/base/map/查/备注）
 * @param {object} [o.现] 中转配置（含 路由/名/fallback）
 * @param {object|null} [o.health] 中转 /health 详情（含路由链和实际先试项）
 * @param {object|null} [o.康] 中转健康探测结果（含 ok）
 * @param {string} [o.监听] 网关监听地址
 */
export function 派生四层({ 候选 = [], 现 = {}, health = null, 康 = null, 监听 = '127.0.0.1:39401' } = {}) {
  const 表 = new Map()
  const 路由表 = []
  const 链集 = new Set(
    (Array.isArray(现 && 现.路由) ? 现.路由 : []).map((x) => String(x)),
  )

  for (const c of 候选) {
    const 上游 = String((c && c.上游) || '') || 官方
    let p = 表.get(上游)
    if (!p) {
      p = { id: 'p:' + 上游, 名: 上游, 上游, 钥匙: [], 模型: new Set() }
      表.set(上游, p)
    }
    const id = String((c && c.id) || '')
    p.钥匙.push(id)
    for (const m of Object.values((c && c.map) || {})) if (m) p.模型.add(String(m))
    路由表.push({
      id,
      名: String((c && c.名) || id),
      供应商: p.id,
      映射: (c && c.map) || {},
      健康: c && c.查 ? (c.查.ok ? 'ok' : 'bad') : '',
      备注: String((c && c.备注) || ''),
      在链里: 链集.has(id),
      // QUOTA 2026-11-17（批次672）：成员行要画用量条。中转 /health 里 `余额` 多数是 null
      // （portdan 只在 /v1/usage 里给钱，还得现查），所以余额原样带出去，没有就是 null；
      // 今日次数/token 来自面板已有的用量汇总，不另外算一套口径。
      余额: (c && c.查 && typeof c.查.余额 === 'number') ? c.查.余额 : null,
      币: String((c && c.查 && c.查.币) || ''),
      今日: (c && c.用量) || null,
      倍率: (c && typeof c.当前倍率 === 'number') ? c.当前倍率 : null,
      峰谷: !!(c && c.峰谷),
      停用: !!(c && c.停用),
    })
  }

  // 链优先用中转算出来的（它才知道谁在冷却、谁快没钱了）；中转挂了就退回配置里排的意图。
  const 链 = (health && Array.isArray(health.路由) && health.路由.length)
    ? health.路由.map((x) => String((x && x.id) || ''))
    : [...链集]
  const 先试 = 康?.ok && health?.先试 && Array.isArray(health.路由)
    ? health.路由.find((项) => 项?.id === health.先试)
    : null

  return {
    供应商: [...表.values()].map((p) => ({
      id: p.id,
      名: p.名,
      上游: p.上游,
      钥匙数: p.钥匙.length,
      钥匙: p.钥匙,
      模型: [...p.模型],
    })),
    路由: 路由表,
    路由组: {
      id: 'g:default',
      名: String((现 && 现.组名) || '默认'),
      策略: 'rate',
      成员: 链,
      启用: 链.length,
      空链: 链.length === 0,
      说明: 链.length === 0
        ? '未排顺序：只试「当前这把 + 兜底」'
        : '按当前倍率从低到高试：便宜的先用；倍率相同按面板顺序；失败或余额低才换下一把。',
    },
    网关: {
      监听,
      活着: !!(康 && 康.ok),
      当前: String(先试?.名 || ''),
      兜底: 现 && 现.fallback && 现.fallback.base
        ? String(现.fallback.base).replace(/^https?:\/\//, '')
        : '',
    },
  }
}

/**
 * LASTREQ 2026-11-17（批次671）：挑出流水里「最后一条真的调过模型的对话」，
 * 压成拓扑卡下半段要的形状。
 *
 * 为什么要挑而不是直接取最后一行：流水里混着 omni（听/说）、探针、以及 466 记的
 * 「0 token + 十几毫秒」测试噪音。直接取最后一行，卡上会显示 0 / 0 ms，看着像坏了。
 *
 * @param {Array} rows 流水（旧→新）
 * @param {(r:object)=>string} 名函数 把一行归到某把钥匙的显示名
 */
export function 最近一个请求(rows, 名函数 = (r) => String((r && r.上游) || '')) {
  const 列 = Array.isArray(rows) ? rows : []
  for (let i = 列.length - 1; i >= 0; i -= 1) {
    const r = 列[i]
    if (!r || typeof r !== 'object') continue
    if (r.omni) continue
    const 用 = String(r.用途 || '对话')
    if (用 !== '对话' && 用 !== '看图' && 用 !== '工具回填') continue
    const 入 = Number(r.入) || 0
    const 出 = Number(r.出) || 0
    if (入 + 出 <= 0) continue
    const 缓读 = Number(r.缓读) || 0
    const 轨迹 = Array.isArray(r.路由) ? r.路由.filter(Boolean) : []
    return {
      at: String(r.at || ''),
      上游: String(名函数(r) || ''),
      模型: String(r.实际模型 || r.模型 || ''),
      用途: 用,
      流式: r.流式 === true,
      入,
      出,
      缓读,
      缓存率: 入 > 0 ? Math.round((缓读 / 入) * 1000) / 10 : 0,
      // 670 之前的老记录 `首字` 恒为 0 —— 给 null，让前端显示「—」，不假装 0ms。
      首字: Number(r.首字) > 0 ? Number(r.首字) : null,
      首字口径: String(r.首字口径 || ''),
      毫秒: Number(r.毫秒) || 0,
      思考: Number(r.思考) || 0,
      兜底: r.兜底 === true,
      摘要: String(r.摘要 || ''),
      路由: 轨迹.map((x) => ({
        名: String(x.名 || ''),
        命中: x.命中 === true,
        状态: Number(x.状态) || 0,
        因: String(x.因 || x.不换 || ''),
      })),
    }
  }
  return null
}

/**
 * STATS 2026-11-17（批次672）：拓扑卡底部那三个数 —— 请求 / 改道 / 上游错误。
 *
 * 抄的是 magpie 路由页底部统计条的形态，但口径必须能从我们自己的流水里算出来：
 *   请求 = 真的调过模型的行（omni 和 0 token 的探针噪音不算）
 *   改道 = 一条请求里换了几次才命中（轨迹长度 - 1）
 *   错误 = 轨迹里出现 HTTP >= 400 的次数（最终成功也算，因为那是真实发生过的失败）
 *
 * 纯函数：调用方自己决定传「今日」还是「近 7 天」的行。
 */
export function 路由统计(rows) {
  const 列 = Array.isArray(rows) ? rows : []
  let 请求 = 0
  let 改道 = 0
  let 错误 = 0
  for (const r of 列) {
    if (!r || typeof r !== 'object') continue
    if (r.omni) continue
    // 口径跟 最近一个请求() 对齐：只算她真的在对话/看图/工具回填时的调用。
    // 上游探测和标题生成也是真请求，但它们不由「聊天」触发，算进来会让
    // 主人看到「今天 400 次请求」而实际只聊了 80 句。
    const 用 = String(r.用途 || '对话')
    if (用 !== '对话' && 用 !== '看图' && 用 !== '工具回填') continue
    const 入 = Number(r.入) || 0
    const 出 = Number(r.出) || 0
    if (入 + 出 <= 0) continue
    请求 += 1
    const 轨迹 = Array.isArray(r.路由) ? r.路由.filter(Boolean) : []
    if (轨迹.length > 1) 改道 += 轨迹.length - 1
    for (const x of 轨迹) if (Number(x && x.状态) >= 400) 错误 += 1
  }
  return { 请求, 改道, 错误 }
}
