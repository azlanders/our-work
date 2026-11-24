import { createHash } from 'node:crypto'
/**
 * usage-解析.mjs —— 判「这次在干什么」+ 抠 token（批次310）
 *
 * 为什么单独成文件：原来这两段埋在 接口中转.mjs 里，而那个文件顶层就
 * createServer().listen()，测试一 import 就抢 39301 端口。抽成纯函数才能单测。
 */

/**
 * FIRSTBYTE 2026-11-17（批次670）：判断一段 SSE / 响应文本里「正文真正开始」没有。
 *
 * 原来的判据只认 OpenAI 形状 `"content":"…"`，但我们走的是 **Anthropic /v1/messages**：
 *   - 流式：`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}`
 *   - 非流式：`{"content":[{"type":"text","text":"…"}]}`
 * 两种都对不上那条正则，所以 2790 条流水的 `首字` **全是 0**，面板画不出首字耗时。
 *
 * 这里放宽成「三种形状任一见字就算」：
 *   1. `"text":"<非空>`（Anthropic 流式 text_delta / thinking_delta）
 *   2. `"content":"<非空>`（OpenAI 兼容流式）
 *   3. `"type":"text","text"` 这类非流式块 —— 由调用方在响应结束时兜底
 * 空串不算（`"text":""` 是块开始/结束标记，不是「她开始说话」）。
 * 只看一小段前缀就够：调用方按 chunk 调用，命中一次就不再调用。
 */
export function 见到正文(s) {
  const t = typeof s === 'string' ? s : ''
  if (!t) return false
  return /"(?:text|content|reasoning_content)"\s*:\s*"[^"\\]/.test(t)
}

/**
 * ROUTE_HIT 2026-11-17（批次670）：把「这次试过哪些、最后用了哪条」压成一行给流水。
 *
 * 原来只有 `试过.length ? 试过 : undefined` —— 成功的请求（绝大多数）**根本不记路由**，
 * 2911 条里只有 38 条有，而且那 38 条全是失败。面板的「最近一个请求怎么路由的」只能猜。
 *
 * 约定：`路由` 永远是数组，按尝试顺序；每项 `{名, 状态?, 因?, 命中?}`。
 * 命中的那条带 `命中:true`，其余是失败尝试。没试过任何一条（比如直接 503）给空数组。
 */
export function 路由轨迹(试过, 选中) {
  const 列 = Array.isArray(试过) ? 试过.filter(Boolean).map((x) => ({ ...x })) : []
  const 中名 = String((选中 && (选中.名 || 选中.base)) || '')
  if (!中名) return 列
  const 已有 = 列.findIndex((x) => String(x.名 || '') === 中名 && !x.因 && !x.不换)
  if (已有 >= 0) {
    列[已有] = { ...列[已有], 命中: true }
    return 列
  }
  // 第一条就成功：试过里没有它，补一条
  列.push({ 名: 中名, 命中: true })
  return 列
}

/** 从请求体里抠一份「这次在聊什么」。 */
export function 摘要(请求) {
  const out = { tip: '', kind: '对话', 模型: '', 流式: false, 图: false, 工具: '' }
  if (!请求 || typeof 请求 !== 'object') return out
  out.模型 = String(请求.model || '')
  out.流式 = 请求.stream === true
  const msgs = Array.isArray(请求.messages) ? 请求.messages : []
  // CLASSIFY_LAST_TURN 2026-11-09（批次310）：**只看最后一条消息**。
  // 原来扫整个 history 找 tool_result —— 而 DSH 的会话里只要调过一次工具，历史里就永远留着
  // tool_result，于是之后每一轮都被判成「工具回填」。线上 101 条流水里 101 条都是「工具回填」、
  // 摘要全是同一句用户原话，这就是病因。
  const 末条 = msgs.length ? (msgs[msgs.length - 1] || {}) : {}
  const 末块 = Array.isArray(末条.content) ? 末条.content : []
  const 工具回填 = 末条.role === 'tool'
    || 末块.some((b) => b && (b.type === 'tool_result' || b.type === 'function_call_output'))
  const 带图 = 末块.some((b) => b && (b.type === 'image' || b.type === 'image_url'))
  if (工具回填) {
    // 工具名从「往前最近一条 assistant 的 tool_calls」里拿 —— 工具结果本身只有 call_id，
    // 光看 id 看不出她刚才在做什么。
    let 工具名 = ''
    for (let i = msgs.length - 1; i >= 0 && !工具名; i -= 1) {
      const m = msgs[i]
      if (!m) continue
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const t = m.tool_calls[m.tool_calls.length - 1]
        工具名 = String((t && t.function && t.function.name) || t.name || '')
      } else if (Array.isArray(m.content)) {
        const u = m.content.filter((b) => b && b.type === 'tool_use').pop()
        if (u) 工具名 = String(u.name || '')
      }
    }
    // 摘要 = 工具名 + 结果头 30 字；不再重复「他上次说的那句话」
    let 文 = ''
    // SUMMARY_READABLE 2026-11-14（批次389）：tool_result 的 content 常常是数组
    // [{type:'text', text:'…'}]，原来直接 JSON.stringify，面板上就是
    // `qq_pass → [{"type":"text","text":"划走了。这次` —— 人读不了。
    const 抽文 = (c) => {
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        return c.map((x) => {
          if (!x || typeof x !== 'object') return ''
          if (x.type === 'text') return String(x.text || '')
          if (x.type === 'image' || x.type === 'image_url') return '[图]'
          return ''
        }).filter(Boolean).join(' ')
      }
      if (c && typeof c === 'object') return JSON.stringify(c)
      return ''
    }
    if (typeof 末条.content === 'string') 文 = 末条.content
    else {
      for (const b of 末块) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'tool_result') 文 = 抽文(b.content)
        else if (b.type === 'function_call_output') 文 = String(b.output || '')
        else if (b.type === 'text' && !文) 文 = String(b.text || '')
      }
    }
    out.工具 = 工具名
    out.tip = (工具名 ? 工具名 + ' → ' : '') + String(文 || '').replace(/\s+/g, ' ').trim().slice(0, 30)
    out.kind = '工具回填'
    out.图 = 带图
    return out
  }
  for (let i = msgs.length - 1; i >= 0 && !out.tip; i -= 1) {
    const m = msgs[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    let text = ''
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string') { text = b.text; break }
      }
    }
    // 她收到的消息常带注入前缀（（关于他：…）[20:11]），摘要里剥掉，只留他真正说的话。
    // 剥不干净就保留原样——宁可难看，不能把能读的字也剪了。
    let 净 = String(text || '')
    for (let k = 0; k < 4; k += 1) {
      const 前 = 净
      // 只剥「像注入」的括号块：里面有冒号，或提到关于他/QQ/群/记忆/当前/系统。
      // 「（笑）」「（小声）」是她说话的一部分，不能剪。
      // INJECT_STRIP 2026-11-14（批次389）：上限原来 80 字，而 identityNote 那种
      // 「（关于他：称呼…；记得…；这次…）」动辄两三百字，剥不掉 —— 面板上「对话」那条
      // 显示的全是注入块，他真正说的话被挤出 32 字之外看不见。放到 400。
      // 仍然要求里面有冒号或关键词，「（笑）」「（小声）」这种不会被吃掉。
      净 = 净.replace(/^\s*[（(]([^）)]{0,400})[）)]\s*/u, (m0, inner) =>
        (/[：:]/.test(inner) || /关于他|QQ|群|记忆|当前|系统/.test(inner)) ? '' : m0)
      // 带 [HH:MM] 标记时，优先取最后一个标记之后 —— 那是他真正说的话。
      // 前面全是注入（时间线/状态/关于他），剥不干净时这条兜底最有效。
      // 用贪婪前缀替换而不是 match：一条消息里可能有多个 [HH:MM]，
      // match 从第一个开始，切出来还带着后面的标记。
      const 切 = 净.replace(/^[\s\S]*\[\d{1,2}:\d{2}\]\s*/, '')
      if (切.trim().length >= 2 && 切 !== 净) 净 = 切.trim()
      净 = 净.replace(/^\s*\[\d{1,2}:\d{2}\]\s*/u, '')
      if (净 === 前) break
    }
    out.tip = String(净 || text || '').replace(/\s+/g, ' ').trim().slice(0, 32)
  }
  out.图 = 带图
  out.kind = 带图 ? '看图' : '对话'
  return out
}

/**
 * 从响应文本里抠 token，拆成五类（批次310，对齐 magpie 的口径）。
 *
 * 为什么必须拆：缓存命中的输入便宜十倍，混在「入」里只会觉得「她好贵」，
 * 实际大半是命中缓存的上下文重复读。不显示命中率，用量页就没有诊断价值。
 */
export function 抠usage(text) {
  // 缺字段不等于零；保留数字字段兼容旧面板，用标记供统计区分。
  const 缓读已知 = /"(?:prompt_cache_hit_tokens|cache_read_input_tokens)"\s*:\s*\d+/.test(text)
    || /"prompt_tokens_details"\s*:\s*\{[^{}]*"cached_tokens"\s*:\s*\d+/.test(text)
  const 取 = (re) => {
    let v = 0
    let m
    while ((m = re.exec(text)) !== null) v = Math.max(v, Number(m[1]) || 0)
    return v
  }
  // Anthropic 用 input_tokens / output_tokens；OpenAI 与 DeepSeek 用 prompt_ / completion_
  const 原入 = Math.max(取(/"prompt_tokens"\s*:\s*(\d+)/g), 取(/"input_tokens"\s*:\s*(\d+)/g))
  const 出 = Math.max(取(/"completion_tokens"\s*:\s*(\d+)/g), 取(/"output_tokens"\s*:\s*(\d+)/g))
  const 缓读 = Math.max(取(/"prompt_cache_hit_tokens"\s*:\s*(\d+)/g), 取(/"cache_read_input_tokens"\s*:\s*(\d+)/g), 取(/"prompt_tokens_details"\s*:\s*\{[^{}]*"cached_tokens"\s*:\s*(\d+)/g))
  // miss = 没命中、要全价算的那部分；Anthropic 那边对应 cache_creation
  const 缓写 = Math.max(取(/"prompt_cache_miss_tokens"\s*:\s*(\d+)/g), 取(/"cache_creation_input_tokens"\s*:\s*(\d+)/g))
  const 思考 = 取(/"reasoning_tokens"\s*:\s*(\d+)/g)
  // 两种口径的差别：OpenAI 的 prompt_tokens **包含**命中缓存的部分，Anthropic 的
  // input_tokens **不含** cache_read/cache_creation。统一成「总输入」，否则命中率算错。
  const 是OpenAI = /"prompt_tokens"\s*:/.test(text)
  const 入 = 是OpenAI ? 原入 : (原入 + 缓读 + 缓写)
  return { 输入: 入, 输出: 出, 缓读, 缓写, 思考, 缓读已知 }
}

/** 仅记录形状和摘要哈希，不记录工具说明、系统提示或消息正文。字符数不当作token。 */
export function 请求观测(request) {
  const input = request && typeof request === 'object' ? request : {}
  const tools = Array.isArray(input.tools) ? input.tools : []
  const messages = Array.isArray(input.messages) ? input.messages : []
  const system = input.system ?? ''
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  // SYSCNT 2026-11-14（批次396）：原来只数 `type === 'text'` 的块。
  // 后果：走 systemPrompt.context() 拼进去的几段（qq-soul / qq-state / memewiki 预查）
  // 块结构不带 type:'text'，**一个字都不计** —— 实测 SOUL.md 1712→1864（+152），
  // 系统字符一直是 6871 纹丝不动，而系统哈希换了新的。指标在骗人。
  // 现在按「块里有没有文字」数：string 块、text 字段、content 字段都算。
  // ⚠ 2026-11-14 之前的系统字符是**低估**，别再拿它跟旧数字比。
  const 块字数 = (b) => {
    if (typeof b === 'string') return b.length
    if (!b || typeof b !== 'object') return 0
    for (const k of ['text', 'content']) if (typeof b[k] === 'string') return b[k].length
    return 0
  }
  const textChars = (value) => typeof value === 'string' ? value.length
    : Array.isArray(value) ? value.reduce((n, b) => n + 块字数(b), 0) : 0
  let images = 0, resultChars = 0
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (b?.type === 'image' || b?.type === 'image_url') images++
      if (b?.type === 'tool_result') {
        resultChars += textChars(b.content)
        walk(b.content)
      }
    }
  }
  for (const m of messages) {
    walk(m?.content)
    if (m?.role === 'tool') resultChars += textChars(m.content)
  }
  // THINKING_PROBE 2026-11-12（批次366）：记录本次请求有没有要求「思考」。
  // 起因：中转站在带 thinking 时会把思考文本同时写进 thinking 块和 text 块，
  // 宿主把 text 当正文记下、插件照发 —— 用户看到的就是一整段英文思考。
  // dsh 的产物里搜不到 budget_tokens，所以先量真实请求再下结论。
  const thinking = input.thinking
  const 思考态 = !thinking ? '不带'
    : typeof thinking === 'object' ? String(thinking.type || 'object') + (thinking.budget_tokens ? ':' + thinking.budget_tokens : '')
      : String(thinking)
  return {
    思考态: 思考态,
    工具数: tools.length,
    工具描述字符: tools.reduce((n, t) => n + String(t?.description ?? t?.function?.description ?? '').length, 0),
    工具声明字符: JSON.stringify(tools).length,
    工具哈希: hash(tools),
    系统字符: textChars(system),
    系统哈希: hash(system),
    消息数: messages.length,
    图片数: images,
    工具结果字符: resultChars,
  }
}
