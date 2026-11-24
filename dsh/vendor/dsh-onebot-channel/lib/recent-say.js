/**
 * recent-say.js —— 记「我最近在这个群/这个人这儿说过什么」。
 *
 * 为什么需要它（2026-10-31 肥鱼加）：
 *   用户可能在机器人还在跑长任务的时候说「再找两张就停」。这句话排队到队尾，
 *   等机器人忙完才读到，那时它已经忘了自己刚刚发了什么，于是照字面又多干一轮。
 *   把「我刚说过什么」直接摆到下一回合的正文里，它就能先对照再动手，
 *   而不是去翻一遍历史（翻历史一次要一次 OneBot 往返，还容易被协议端限流）。
 *
 * 只放内存、按目标分组、每个目标留最近 6 条：重启就清空 —— 够用，也不落盘不泄内容。
 */

const RING = new Map()
const KEEP = 6

/** 目标 → key（group:xxx / private:xxx）。 */
function keyOf(target) {
  const kind = String(target?.kind ?? '').trim()
  const id = String(target?.id ?? '').trim()
  if (kind === '' || id === '') return ''
  return `${kind}:${id}`
}

/**
 * 记一条「我刚发出去的内容」。
 * @param {{kind?: string, id?: string}|null} target 发送目标
 * @param {string} text 实际发出去的正文（图片/文件可以记成 [图片] 这种占位）
 */
export function noteSaid(target, text) {
  const key = keyOf(target)
  const body = String(text ?? '').trim()
  if (key === '' || body === '') return
  const list = RING.get(key) ?? []
  list.push({ at: Date.now(), text: body.slice(0, 120) })
  while (list.length > KEEP) list.shift()
  RING.set(key, list)
}

/**
 * 取这个目标最近说过的话（旧 → 新）。
 * @param {{kind?: string, id?: string}|null} target
 * @param {number} [n] 最多几条
 * @returns {{at: number, text: string}[]}
 */
export function recentSaid(target, n = KEEP) {
  const key = keyOf(target)
  if (key === '') return []
  const list = RING.get(key) ?? []
  return list.slice(-Math.max(1, n))
}

/** 拼成给模型看的一段（没有就返回空串）。 */
export function recentSaidBlock(target, n = 4) {
  const list = recentSaid(target, n)
  if (list.length === 0) return ''
  const now = Date.now()
  const lines = list.map((item) => {
    const sec = Math.max(0, Math.round((now - item.at) / 1000))
    return `- ${sec} 秒前：${item.text}`
  })
  return `[你刚说过]\n${lines.join('\n')}\n`
}

function 点Of(at) {
  const n = Number(at)
  if (Number.isFinite(n) && n > 0) return new Date(n + 8 * 3600e3).toISOString().slice(11, 16)
  const t = Date.parse(String(at ?? '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) : '刚才'
}

/**
 * 重复提示（批次 693）。
 *
 * 实测 2026-11-16 23:22–23:24：80 秒里连发 4 条，「我这边二十度」说了三遍，
 * 同一条认错（「上周那句是我顺口说的」）也说了两遍。
 * 私聊原来根本没有「我刚说过什么」这一段 —— `我说过.jsonl` 只记系统代发的定时话，
 * 不记她聊天里真正发出去的字；`recentSaid` 这个内存环又只在群聊注入。
 *
 * 这里不替她选词，也不拦她开口：只把「哪两句其实是同一件事」算出来摆在她面前。
 *
 * 判据用**最长公共子串**，不是 Jaccard —— 先试过 3-gram Jaccard 0.6，
 * 真实复读「我窗户外头这会儿二十度，晴，能看见星星」vs「我这边窗外这会儿二十度，星星挺亮」
 * 只有 0.22，直接被漏掉：人复述同一件事时会换主语和语序，但中间那截事实几乎不动。
 * 现在要求公共子串 ≥ max(5, 较短一句的 30%)。
 */
export function 重复提示Of(items) {
  const 条 = (Array.isArray(items) ? items : [])
    .filter((x) => x && String(x.text ?? '').trim() !== '')
    .map((x) => ({ at: x.at, text: String(x.text).trim() }))
  if (条.length < 2) return ''
  const 净 = 条.map((x) => x.text.replace(/[\s，。！？、：；…—「」『』（）()《》"'[\]·]/g, ''))
  const 最长公共 = (a, b) => {
    let best = 0
    let prev = new Array(b.length + 1).fill(0)
    for (let i = 1; i <= a.length; i += 1) {
      const cur = new Array(b.length + 1).fill(0)
      for (let j = 1; j <= b.length; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1
          if (cur[j] > best) best = cur[j]
        }
      }
      prev = cur
    }
    return best
  }
  const 命中 = []
  for (let i = 0; i < 条.length; i += 1) {
    for (let j = i + 1; j < 条.length; j += 1) {
      const 短 = Math.min(净[i].length, 净[j].length)
      const 限 = Math.max(5, Math.round(短 * 0.3))
      const 公共 = 最长公共(净[i], 净[j])
      if (公共 >= 限) 命中.push({ i, j, 公共, 相似: 短 === 0 ? 0 : 公共 / 短 })
    }
  }
  if (命中.length === 0) return ''
  // 只报最像的一组 —— 报三组的话，提示本身也变成了重复。
  const 组 = 命中.sort((a, b) => b.相似 - a.相似)[0]
  const 行 = (i) => `- ${点Of(条[i].at)}「${条[i].text.slice(0, 30)}」`
  return `[同一件事] 下面这两句意思相近，说一遍就够了，别连着讲第二遍：\n${行(组.i)}\n${行(组.j)}\n`
}

/**
 * 刚说过段（批次 693）：群聊一直用 `recentSaidBlock`，私聊这回也接上，
 * 顺便附上「哪两句是同一件事」。只递事实，说什么是她自己定。
 */
export function 刚说过段(target, n = 5) {
  const list = recentSaid(target, n + 1)
  if (list.length === 0) return ''
  return recentSaidBlock(target, n) + 重复提示Of(list)
}
