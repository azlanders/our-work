// 语音合成.mjs —— 文本转语音（本机 GPT-SoVITS v2ProPlus 真人少女声线首选 + 云端自动兜底）
//
// 配置放在 {{DSH_ROOT}}/fish-omni.json 的「说」段，**每次调用现读**，面板改完下一句即生效，无需重启。
// 四种协议：
//   · gptsovits（默认推荐！本机 GPT-SoVITS v2ProPlus 少女微调声线，零花栗鼠怪调、零费用、1~4秒极速出音，支持按台词自动挑情感参考音频！）
//   · omni     （云端 Omni 流式配音）
//   · dashscope（百炼原生 qwen3-tts-flash）
//   · openai   （第三方 /audio/speech 兼容接口）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const 配置路径 = process.env.FISH_OMNI_CONFIG || '{{DSH_ROOT}}/fish-omni.json'
const 流水路径 = process.env.FISH_USAGE_LOG || '{{DSH_ROOT}}/fish-usage-log.jsonl'
const 默认出目录 = '{{BOT_ROOT}}/下载'
const GSV_REF_DIR = '/data/gpt-sovits/voices/tangyuge_v2pp/references'
const GSV_DEFAULT_BASE = 'http://127.0.0.1:9880'

export const GSV_SCENES = {
  // HAJIMI_PACK 2026-11-23：她用自己的唐语歌音色包（tangyuge_v2pp），不再借{{ALT_BOT_DISPLAY}}的 feiyu。
  // prompt_text 必须和参考音频里说的话一字不差，否则 GPT 阶段对错文本，出来会飘。
  lively: {
    file: 'lively_daily_script1_L0902.wav',
    prompt: '我记得食堂饮料店的小蛋糕很好吃，在哪儿来着？',
    label: '元气日常（轻快口语）',
    top_k: 10, top_p: 0.9, temperature: 0.82,
  },
  soft: {
    file: 'soft_daily_script22_L0687.wav',
    prompt: '你先随意转转，柜台还有咖啡出售，我先去帮奶奶做最后的准备。',
    label: '温柔日常（松弛）',
    top_k: 8, top_p: 0.85, temperature: 0.78,
  },
  morning: {
    file: 'morning_script43_L0993.wav',
    prompt: '曦铭？这么早就来学校了呀。',
    label: '早安问候（短句清亮）',
    top_k: 10, top_p: 0.9, temperature: 0.82,
  },
  intimate: {
    file: 'intimate_reassure_script41_L0688.wav',
    prompt: '亲爱的，已经没事了，不去理她就好。',
    label: '贴耳哄睡（安抚）',
    top_k: 8, top_p: 0.85, temperature: 0.76,
  },
  romantic: {
    file: 'romantic_soft_script34_L0448.wav',
    prompt: '可以吗亲爱的？会不会占用你太多时间了？',
    label: '软声撒娇（轻软）',
    top_k: 8, top_p: 0.85, temperature: 0.78,
  },
  food: {
    file: 'food_daily_script43_L0998.wav',
    prompt: '喏，给你带的早餐，快趁热吃吧。',
    label: '投喂关心（生活感）',
    top_k: 8, top_p: 0.85, temperature: 0.78,
  },
  exclaim: {
    file: 'exclaim_script32_L0066.wav',
    prompt: '就是这个！读起来十分可爱呢！',
    label: '开心感叹（灵动）',
    top_k: 12, top_p: 0.92, temperature: 0.85,
  },
  question: {
    file: 'question_clear_script34_L0420.wav',
    prompt: '我还没来得及详细问，他是不是生病了？',
    label: '好奇发问（尾音自然）',
    top_k: 8, top_p: 0.85, temperature: 0.78,
  },
}

// 音色包：参考音频目录 + 权重。单进程 9880 靠 set_* 端点热切换，避免再起一份吃 4G 内存。
const GSV_PACK = {
  key: 'tangyuge_v2pp',
  gpt: '/data/gpt-sovits/voices/tangyuge_v2pp/weights/tangyuge_v2pp_dpo-e10.ckpt',
  sovits: '/data/gpt-sovits/voices/tangyuge_v2pp/weights/tangyuge_v2pp_e4_s564.pth',
}
let 当前音色包 = ''

async function 换音色包(fetchFn, base) {
  if (当前音色包 === GSV_PACK.key) return null
  for (const [ep, p] of [['set_gpt_weights', GSV_PACK.gpt], ['set_sovits_weights', GSV_PACK.sovits]]) {
    const r = await fetchFn(base.replace(/\/+$/, '') + '/' + ep + '?weights_path=' + encodeURIComponent(p), { method: 'GET', signal: AbortSignal.timeout(60000) })
    const t = await r.text().catch(() => '')
    if (!r.ok) return '音色包切换失败（' + ep + '）：' + String(t).slice(0, 120)
  }
  当前音色包 = GSV_PACK.key
  return null
}

/** 根据台词内容与标点自动挑选最贴切的情感参考切片（当 voice='auto' 时生效）。 */
export function 挑情感切片(话, 指定音色 = 'auto') {
  const key = String(指定音色 || 'auto').trim().toLowerCase()
  if (key && key !== 'auto' && GSV_SCENES[key]) return { key, ...GSV_SCENES[key] }
  const s = String(话 || '').trim()
  // ORDER 2026-11-13（批次373）：原来第一行把「长度 <= 6」和早安关键词并列，
  // 于是「真的假的！」「好，我知道了」这种 5~6 字的短句**在进到感叹/疑问判断之前**
  // 就被当成早安问候走了 morning 参考 —— 感叹句拿清晨问候的语气念，怎么听都不对。
  // 现在只把关键词留在最前，长度兜底挪到所有关键词判断之后。
  if (/早安|早上好|刚醒|起床|你好|嗨|哈喽|在吗/.test(s)) return { key: 'morning', ...GSV_SCENES.morning }
  if (/晚安|睡啦|去睡|好梦|抱抱|没事|乖乖|摸摸|累了|困/.test(s)) return { key: 'intimate', ...GSV_SCENES.intimate }
  if (/吃|喝|饿|渴|早饭|牛奶|蛋糕|火锅|奶茶|点心|宵夜/.test(s)) return { key: 'food', ...GSV_SCENES.food }
  if (/好不好|可以吗|求求|陪我|想你|理理我|嘛～|呀～/.test(s)) return { key: 'romantic', ...GSV_SCENES.romantic }
  if (/[！!]{1,}|太棒|好耶|哇|真的假的|厉害|可爱|开心|哈哈|嘿嘿/.test(s)) return { key: 'exclaim', ...GSV_SCENES.exclaim }
  if (/[？?]$|怎么|为什么|是不是|哪儿|什么呀/.test(s)) return { key: 'question', ...GSV_SCENES.question }
  // LIVELY_LIMIT 2026-11-13（批次373）：原来是 22 字。主人说「结尾那个字收得不好」，
  // 量出来最后一个字峰值达强电平 156%。查参考音频：lively.wav 的尾段是 0.0576（强电平 53%），
  // soft.wav 的尾段只有 0.0145（12%）—— lively 这条参考本身就收得上挑，模型照着学。
  // 所以把门槛压到 12 字：短句、寒暄、感叹仍走 lively（保持活泼），
  // 13 字以上的叙述句落到 soft，收尾更稳。
  if (s.length <= 6) return { key: 'morning', ...GSV_SCENES.morning }   // 极短句仍用清亮那条
  if (s.length <= 12) return { key: 'lively', ...GSV_SCENES.lively }
  return { key: 'soft', ...GSV_SCENES.soft }
}

/** 清理不适合直接送进 TTS 前端的颜文字/括号动作/波浪号，避免念出怪声。 */
function 净台词(raw) {
  let s = String(raw || '')
    .replace(/\[表情:[^\]]*\]/g, '')
    .replace(/\[[A-Za-z0-9_\u4e00-\u9fa5]+\]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[～~]+/g, '，')
    .replace(/w{3,}/gi, '哈哈')
    .replace(/\s+/g, ' ')
    .trim()
  if (s && !/[。！？!?….,，]$/.test(s)) s += '。'
  return s
}

export function 读配置() {
  try {
    const v = JSON.parse(readFileSync(配置路径, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function 推导地址(rawBase, 协议) {
  const b = String(rawBase || '').replace(/\/+$/, '')
  if (协议 === 'gptsovits') {
    if (!b || /aliyuncs|portdan/i.test(b)) return GSV_DEFAULT_BASE
    return b
  }
  if (!b) return ''
  if (协议 === 'dashscope') return b.replace(/\/compatible-mode\/v1$/, '/api/v1')
  if (协议 === 'omni') return /\/api\/v1$/.test(b) ? b.replace(/\/api\/v1$/, '/compatible-mode/v1') : b
  return b
}

export function 说配置(env = process.env) {
  const 全 = 读配置()
  const c = 全['说'] || {}
  const 听 = 全['听'] || {}
  const rawProto = String(c['协议'] || 'gptsovits').toLowerCase()
  const 协议 = ['gptsovits', 'omni', 'dashscope', 'openai'].includes(rawProto) ? rawProto : 'gptsovits'
  const 源base = String(c['base'] || '')
  const 云base = String(听['base'] || env.DASHSCOPE_BASE_URL || '')
  const base = 协议 === 'gptsovits'
    ? 推导地址(源base, 'gptsovits')
    : 推导地址(源base || 云base, 协议)
  let 模型 = String(c['模型'] || '').trim()
  if (协议 === 'gptsovits') 模型 = 模型 && !/qwen|tts-flash/i.test(模型) ? 模型 : 'tangyuge-v2ProPlus'
  else if (协议 === 'omni') 模型 = !模型 || /tts|tangyuge/i.test(模型) ? 'qwen3-omni-flash' : 模型
  else if (协议 === 'dashscope') 模型 = !模型 || /omni|tangyuge/i.test(模型) ? 'qwen3-tts-flash' : 模型
  let 音色 = String(c['音色'] || '').trim()
  if (协议 === 'gptsovits') {
    if (!音色 || /^(Cherry|Momo|Bella|Vivian|Bunny|Nini|Chelsie|Serena|Mia)$/i.test(音色)) 音色 = 'auto'
  } else if (!音色 || 音色 === 'auto' || GSV_SCENES[音色]) {
    音色 = 'Cherry'
  }
  return {
    协议,
    base,
    云base,
    key: String(c['key'] || 听['key'] || env.DASHSCOPE_API_KEY || ''),
    模型,
    音色,
    语气: String(c['语气'] || '饰演软萌可爱的蓝鲸少女{{ALT_BOT_DISPLAY}}，像真人少女贴着手机发语音一样软糯自然。').trim(),
    // 吸气声压制强度：0 = 关，0.6 = 默认，1 = 最狠。留在 fish-omni.json 的 说.去气声 里调。
    去气声: (() => {
      const v = Number(c['去气声'])
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.85
    })(),
  }
}

export function 说明(env = process.env) {
  const c = 说配置(env)
  if (c.协议 === 'gptsovits') return c.base ? '' : '没有本机 GPT-SoVITS 地址'
  if (!c.key) return '没有 key（配置里和 DASHSCOPE_API_KEY 都是空）'
  if (!c.base) return '没有 base（配置里和 DASHSCOPE_BASE_URL 都是空）'
  return ''
}

const 京分 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 时间戳 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().replace(/[-:T.]/g, '').slice(0, 14)

function 记用量(o) {
  try {
    const 行 = {
      at: 京分(),
      上游: (o.本地 ? 'local · ' : 'omni · ') + String(o.模型 || ''),
      模型: String(o.模型 || ''),
      用途: String(o.用途 || '语音合成'),
      入: Number(o.入) || 0, 出: Number(o.出) || 0, 缓读: 0, 缓写: 0, 思考: 0,
      omni: '说',
      字: Number(o.字) || 0,
      用时毫秒: Number(o.用时) || 0,
      结果: o.成功 ? 'ok' : String(o.原因 || '失败').slice(0, 60),
    }
    writeFileSync(流水路径, JSON.stringify(行) + '\n', { flag: 'a' })
  } catch {}
}

function 嗅扩展(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (buf.length > 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3'
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'
  return 'mp3'
}

/**
 * 压低吸气声：只吃「有声但很轻」的帧，正常说话一个样本都不动。
 *
 * BREATH_GATE 2026-11-12（批次371）：主人说吸气声太重。
 * 实测一条 3.5 秒的合成音里，低于强电平 12% 的帧占了 43.6%，
 * 吸气声正好落在这段。这里做向下扩展：这些帧压到 (1-0.72*强度)，
 * 其余帧原样；增益做 ±4 帧平滑，否则会听见「吧嗒吧嗒」的开关声。
 *
 * 强度 0 = 关，0.85 = 默认，1 = 最狠（约 -16.5 dB）。
 * 只处理 16bit PCM 的 RIFF/wav，别的一律原样返回。
 */
export function 降气声(buf, 强度 = 0.6) {
  const s = Math.max(0, Math.min(1, Number(强度) || 0))
  if (!(s > 0) || !Buffer.isBuffer(buf) || buf.length < 128) return buf
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return buf
  let p = 12, ch = 1, sr = 24000, bits = 16, 数据 = -1, 长度 = 0
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4)
    const sz = buf.readUInt32LE(p + 4)
    if (id === 'fmt ') {
      ch = buf.readUInt16LE(p + 10) || 1
      sr = buf.readUInt32LE(p + 12) || 24000
      bits = buf.readUInt16LE(p + 22) || 16
    } else if (id === 'data') {
      数据 = p + 8
      长度 = Math.min(sz, buf.length - 数据)
      break
    }
    p += 8 + sz + (sz & 1)
  }
  if (数据 < 0 || bits !== 16 || 长度 <= 0) return buf

  // BREATH_GATE2 2026-11-12（批次371）：按「周期性」而不是只按音量判吸气声。
  // 实测 5~15% 强电平那档的自相关峰只有 0.21（噪声），15~40% 是 0.46（混着轻声语音），
  // 40% 以上 0.58~0.75（正常语音）。所以：周期性低 + 电平不算高 = 吸气声。
  const 框样 = Math.max(1, Math.round(sr * 0.02)) * ch
  const 框数 = Math.floor(长度 / (框样 * 2))
  if (框数 < 4) return buf
  const 单 = Math.max(1, Math.round(框样 / ch))
  const 低迟 = Math.max(2, Math.floor(sr / 320))
  const 高迟 = Math.min(单 - 2, Math.ceil(sr / 70))

  const rms = new Float64Array(框数)
  const 周期 = new Float64Array(框数)
  const 样 = new Float32Array(单)
  for (let f = 0; f < 框数; f++) {
    const 基 = 数据 + f * 框样 * 2
    let 均 = 0
    for (let i = 0; i < 单; i++) {
      const v = buf.readInt16LE(基 + i * ch * 2) / 32768
      样[i] = v
      均 += v
    }
    均 /= 单
    let 能 = 0
    for (let i = 0; i < 单; i++) { 样[i] -= 均; 能 += 样[i] * 样[i] }
    rms[f] = Math.sqrt(能 / 单)
    if (能 < 1e-9) { 周期[f] = 0; continue }
    let 峰 = 0
    for (let lag = 低迟; lag <= 高迟; lag++) {
      let c = 0
      for (let i = 0; i + lag < 单; i++) c += 样[i] * 样[i + lag]
      c /= 能
      if (c > 峰) 峰 = c
    }
    周期[f] = 峰
  }

  const 排 = Array.from(rms).sort((a, b) => a - b)
  const 强 = 排[Math.floor(排.length * 0.9)] || 0
  if (强 <= 0) return buf
  const 底线 = 1 - 0.85 * s         // 强度 1 → 0.15（约 -16.5 dB）

  // TAIL_GUARD 2026-11-12（批次372）：字尾越轻，周期性越低，正好落进「噪声」判据，
  // 会被削成半截 —— 主人说的「最后一个字收得不好」有一部分就是这么来的。
  // 所以先标出「最近 80ms 内有过语音」的帧，这些一律不衰减。
  // 吸气多在停顿中间或句首，离语音 >80ms，不受这条保护。
  const 有语音 = new Uint8Array(框数)
  for (let f = 0; f < 框数; f++) if (周期[f] >= 0.42 && rms[f] / 强 >= 0.08) 有语音[f] = 1
  const 保护 = new Uint8Array(框数)
  for (let f = 0; f < 框数; f++) {
    let 保 = 0
    for (let k = -0; k <= 0; k++) {          // 实测：连 2 帧（20ms）都会挡住大半吸气 —— 吸气常贴着字边界。
      // 字尾本来就响（156% 强电平），已被「响的不动」那条挡住，这里不需要再做 hangover。
      // 曾经写成 -8（80ms），结果 80ms 内几乎总有语音，把闸门整个关掉了 —— 实测噪声带 0.0 dB。
      // 而且真正的字尾本来就响（实测 156% 强电平），已经被「响的不动」那条保护住，不需要这么宽的 hangover。
      const i = f + k
      if (i >= 0 && 有语音[i]) { 保 = 1; break }
    }
    保护[f] = 保
  }

  const 增 = new Float64Array(框数)
  for (let f = 0; f < 框数; f++) {
    const 电平 = rms[f] / 强
    if (电平 >= 0.5) { 增[f] = 1; continue }        // 响的不动：s/sh 这类清音不能被削
    if (电平 < 0.02) { 增[f] = 1; continue }        // 纯静音也没什么可压
    if (保护[f]) { 增[f] = 1; continue }            // 字尾保护（当前窗口 0 帧 = 不启用，见下）
    const q = 周期[f]
    if (q >= 0.48) 增[f] = 1                        // 周期性够强 = 语音
    else if (q <= 0.38) 增[f] = 底线                 // 噪声帧 = 吸气声
    else 增[f] = 底线 + (1 - 底线) * ((q - 0.38) / 0.10)
    // 阈值从 0.30/0.42 放宽到 0.38/0.48：实测 0.30 那档只压到 -5.8 dB，而 5~15% 电平段的
    // 平均周期性是 0.21、15~40% 段是 0.46 —— 卡在 0.30 的帧其实多半也是气声。
  }
  // 3 抽头平滑两次（≈14ms），只为去掉开关声，不再把短段摊平
  const 平1 = new Float64Array(框数)
  for (let f = 0; f < 框数; f++) 平1[f] = 0.25 * 增[Math.max(0, f - 1)] + 0.5 * 增[f] + 0.25 * 增[Math.min(框数 - 1, f + 1)]
  const 平 = new Float64Array(框数)
  for (let f = 0; f < 框数; f++) 平[f] = 0.25 * 平1[Math.max(0, f - 1)] + 0.5 * 平1[f] + 0.25 * 平1[Math.min(框数 - 1, f + 1)]

  for (let f = 0; f < 框数; f++) {
    if (平[f] >= 0.999) continue
    const 基 = 数据 + f * 框样 * 2
    for (let i = 0; i < 框样; i++) {
      const 位 = 基 + i * 2
      const v = Math.round(buf.readInt16LE(位) * 平[f])
      buf.writeInt16LE(v < -32768 ? -32768 : v > 32767 ? 32767 : v, 位)
    }
  }
  return buf
}

export function 封装Wav(pcmBuf, sampleRate = 24000) {
  if (pcmBuf.length > 12 && pcmBuf.toString('ascii', 0, 4) === 'RIFF') return pcmBuf
  const evenLen = pcmBuf.length - (pcmBuf.length & 1)
  const out = Buffer.allocUnsafe(44 + evenLen)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + evenLen, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(evenLen, 40)
  pcmBuf.copy(out, 44, 0, evenLen)
  return out
}

async function 存数组(出目录, buf, ms) {
  try { mkdirSync(出目录, { recursive: true }) } catch {}
  const 名 = 'tts-' + 时间戳(ms) + '.' + 嗅扩展(buf)
  const 路径 = join(出目录, 名)
  writeFileSync(路径, buf)
  return { 名, 路径, 字节: buf.length }
}

/** 走本机 GPT-SoVITS v2ProPlus CPUFast (http://127.0.0.1:9880/tts)。 */
async function 走本机GptSovits(话, c, fetchFn, 超时) {
  const 净 = 净台词(话)
  if (!净) return { ok: false, model: c.模型, reason: '清理后台词为空' }
  const sc = 挑情感切片(净, c.音色)
  const refPath = join(GSV_REF_DIR, sc.file)
  if (!existsSync(refPath)) {
    return { ok: false, model: c.模型, reason: '缺少参考音频：' + refPath }
  }
  const url = c.base.replace(/\/+$/, '') + '/tts'
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 净,
      text_lang: 'zh',
      ref_audio_path: refPath,
      prompt_text: sc.prompt,
      prompt_lang: 'zh',
      top_k: sc.top_k,
      top_p: sc.top_p,
      temperature: sc.temperature,
      text_split_method: 'cut5',
      split_bucket: false, // 严禁打乱短长句顺序！
      speed_factor: 1.0,
      fragment_interval: 0.26,
      media_type: 'wav',
      streaming_mode: false,
    }),
    signal: AbortSignal.timeout(超时),
  })
  if (!res.ok) {
    const 尾 = String(await res.text().catch(() => '')).slice(0, 160)
    return { ok: false, model: c.模型, reason: 'GPT-SoVITS HTTP ' + res.status + (尾 ? '：' + 尾 : '') }
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 256) return { ok: false, model: c.模型, reason: 'GPT-SoVITS 返回音频过短' }
  // 吸气声压一道（批次371）。放在这里而不是存文件时 —— 试听和真发语音走同一条路。
  return { ok: true, buf: 降气声(buf, c.去气声), model: c.模型, scene: sc.key }
}

async function 走百炼原生(话, c, fetchFn, 超时) {
  const dashBase = 推导地址(c.云base || c.base, 'dashscope')
  if (!dashBase || !c.key) return { ok: false, model: 'qwen3-tts-flash', reason: '云端兜底未配 key/base' }
  const model = /tts/i.test(c.模型) ? c.模型 : 'qwen3-tts-flash'
  const voice = /^(Cherry|Serena|Chelsie|Momo|Vivian|Mia|Stella|Bella|Nini|Bunny)$/i.test(c.音色) ? c.音色 : 'Cherry'
  const url = dashBase + '/services/aigc/multimodal-generation/generation'
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: { text: 话, voice, language_type: 'Chinese' } }),
    signal: AbortSignal.timeout(超时),
  })
  if (!res.ok) {
    const 尾 = String(await res.text().catch(() => '')).slice(0, 160)
    return { ok: false, model, reason: '上游 HTTP ' + res.status + (尾 ? '：' + 尾 : '') }
  }
  const d = await res.json()
  const 链 = (((d || {}).output || {}).audio || {}).url
  if (typeof 链 !== 'string' || !/^https?:\/\//.test(链)) {
    return { ok: false, model, reason: '上游没返回音频地址：' + JSON.stringify(d).slice(0, 160) }
  }
  const 音频 = await fetchFn(链, { signal: AbortSignal.timeout(超时) })
  if (!音频.ok) return { ok: false, model, reason: '下载音频失败：HTTP ' + 音频.status }
  const buf = Buffer.from(await 音频.arrayBuffer())
  if (!buf.length) return { ok: false, model, reason: '音频是空的' }
  return { ok: true, buf, model }
}

async function 走Omni情感配音(话, c, fetchFn, 超时) {
  const url = c.base + '/chat/completions'
  const voice = /^(Cherry|Serena|Chelsie|Momo|Vivian|Mia|Stella|Bella|Nini|Bunny)$/i.test(c.音色) ? c.音色 : 'Serena'
  const sys = `你是专业配音员。${c.语气}用户给你一句中文台词，请你【一字不差、不增不减】原样用声音演绎出来，绝对禁止自己回答问题、禁止加任何前后缀！`
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.模型,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `请原样念出括号里的字：「${话}」` }],
      modalities: ['text', 'audio'],
      audio: { voice, format: 'wav' },
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: AbortSignal.timeout(超时),
  })
  if (!res.ok) return { ok: false, model: c.模型, reason: 'HTTP ' + res.status }
  const rawText = await res.text()
  const chunks = []
  let usage = null, apiErr = ''
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const d = line.slice(5).trim()
    if (!d || d === '[DONE]') continue
    try {
      const j = JSON.parse(d)
      if (j.error) apiErr = String(j.error.message || JSON.stringify(j.error))
      if (j.usage) usage = j.usage
      const aud = j?.choices?.[0]?.delta?.audio
      if (aud?.data) chunks.push(Buffer.from(aud.data, 'base64'))
    } catch {}
  }
  if (!chunks.length) return { ok: false, model: c.模型, reason: apiErr || '模型未返回音频流' }
  return { ok: true, buf: 封装Wav(Buffer.concat(chunks), 24000), model: c.模型, usage }
}

export async function 合成(文本, opt = {}) {
  const 话 = String(文本 == null ? '' : 文本).trim()
  if (!话) return { ok: false, reason: '文本是空的' }
  if (话.length > 800) return { ok: false, reason: '一次最多 800 字' }
  const c = 说配置(opt.env || process.env)
  const 缺 = 说明(opt.env || process.env)
  if (缺) return { ok: false, reason: 缺 }
  const fetchFn = opt.fetchFn || fetch
  const 出目录 = opt.出目录 || 默认出目录
  const 超时 = Math.max(5000, Number(opt.超时毫秒) || 90000)
  const t0 = Date.now()

  try {
    if (c.协议 === 'gptsovits') {
      const r = await 走本机GptSovits(话, c, fetchFn, 超时)
      if (r.ok) {
        const 落 = await 存数组(出目录, r.buf, Date.now())
        记用量({ 本地: true, 模型: r.model + ':' + r.scene, 字: 话.length, 用时: Date.now() - t0, 成功: true })
        return { ok: true, file: 落.名, path: 落.路径, bytes: 落.字节, 模型: r.model, 音色: r.scene, 用时: Date.now() - t0 }
      }
      // 本机 9880 若暂未就绪，自动降级百炼原生 TTS 兜底，绝不哑火！
      const fb = await 走百炼原生(话, c, fetchFn, 超时)
      if (fb.ok) {
        const 落 = await 存数组(出目录, fb.buf, Date.now())
        记用量({ 模型: fb.model + '（兜底）', 字: 话.length, 用时: Date.now() - t0, 成功: true })
        return { ok: true, file: 落.名, path: 落.路径, bytes: 落.字节, 模型: fb.model + '（兜底）', 音色: 'Cherry', 用时: Date.now() - t0 }
      }
      记用量({ 本地: true, 模型: c.模型, 字: 话.length, 用时: Date.now() - t0, 成功: false, 原因: r.reason })
      return { ok: false, reason: r.reason }
    }

    if (c.协议 === 'omni') {
      const r = await 走Omni情感配音(话, c, fetchFn, 超时)
      if (r.ok) {
        const 落 = await 存数组(出目录, r.buf, Date.now())
        记用量({ 模型: r.model, 字: 话.length, 入: r.usage?.prompt_tokens, 出: r.usage?.completion_tokens, 用时: Date.now() - t0, 成功: true })
        return { ok: true, file: 落.名, path: 落.路径, bytes: 落.字节, 模型: r.model, 音色: c.音色, 用时: Date.now() - t0 }
      }
      const fb = await 走百炼原生(话, c, fetchFn, 超时)
      if (fb.ok) {
        const 落 = await 存数组(出目录, fb.buf, Date.now())
        记用量({ 模型: fb.model + '（兜底）', 字: 话.length, 用时: Date.now() - t0, 成功: true })
        return { ok: true, file: 落.名, path: 落.路径, bytes: 落.字节, 模型: fb.model + '（兜底）', 音色: c.音色, 用时: Date.now() - t0 }
      }
      记用量({ 模型: c.模型, 字: 话.length, 用时: Date.now() - t0, 成功: false, 原因: r.reason })
      return { ok: false, reason: r.reason }
    }

    if (c.协议 === 'dashscope') {
      const r = await 走百炼原生(话, c, fetchFn, 超时)
      if (!r.ok) {
        记用量({ 模型: r.model, 字: 话.length, 用时: Date.now() - t0, 成功: false, 原因: r.reason })
        return { ok: false, reason: r.reason }
      }
      const 落 = await 存数组(出目录, r.buf, Date.now())
      记用量({ 模型: r.model, 字: 话.length, 用时: Date.now() - t0, 成功: true })
      return { ok: true, file: 落.名, path: 落.路径, bytes: 落.字节, 模型: r.model, 音色: c.音色, 用时: Date.now() - t0 }
    }

    const url = c.base + '/audio/speech'
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.模型, input: 话, voice: c.音色, response_format: 'mp3' }),
      signal: AbortSignal.timeout(超时),
    })
    if (!res.ok) {
      const 尾 = String(await res.text().catch(() => '')).slice(0, 160)
      记用量({ 模型: c.模型, 字: 话.length, 用时: Date.now() - t0, 成功: false, 原因: 'HTTP ' + res.status })
      return { ok: false, reason: '上游 HTTP ' + res.status + (尾 ? '：' + 尾 : '') }
    }
    const 型 = String(res.headers.get('content-type') || '')
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, reason: '上游回了个空响应' }
    if (/json/i.test(型) || (buf[0] === 0x7b && buf.length < 4096)) {
      return { ok: false, reason: '上游回的不是音频：' + buf.toString('utf8').slice(0, 160) }
    }
    const 落 = await 存数组(出目录, buf, Date.now())
    记用量({ 模型: c.模型, 字: 话.length, 用时: Date.now() - t0, 成功: true })
    return { ok: true, file: 落.名, path: 落.路径, bytes: 落.字节, 模型: c.模型, 音色: c.音色, 用时: Date.now() - t0 }
  } catch (e) {
    const 因 = String((e && (e.name === 'TimeoutError' ? '超时' : e.message)) || e).slice(0, 120)
    记用量({ 本地: c.协议 === 'gptsovits', 模型: c.模型, 字: 话.length, 用时: Date.now() - t0, 成功: false, 原因: 因 })
    return { ok: false, reason: '合成失败：' + 因 }
  }
}

if (process.argv[1] && process.argv[1].endsWith('语音合成.mjs')) {
  const 文 = process.argv[2] || ''
  const i = process.argv.indexOf('--out')
  const 出 = i > 0 ? process.argv[i + 1] : 默认出目录
  合成(文, { 出目录: 出 }).then((r) => {
    console.log(JSON.stringify(r))
    process.exit(r.ok ? 0 : 1)
  })
}
