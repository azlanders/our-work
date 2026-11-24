/**
 * 工具结果入口裁剪与入站长段落折叠模块
 *
 * 核心设计：
 * 1. 结果进历史前截断（复利机制）：工具（如 bash、read）输出一旦进历史，就会在后续所有轮次被重发。
 *    在这里截断，可在每一轮都节省 token。
 * 2. 掐头去尾保留结构：头部保留 60%（通常是命令环境、字段名、开头几行），尾部保留 40%（统计汇总、执行状态）。
 * 3. 非文本块（图片、音频、JSON）100% 原样保留，绝不触碰。
 * 4. 纯函数设计，fail-open 保证。
 */

export const DEFAULT_MAX_CHARS = 2500;
export const TRIM_MARKER = '\n\n…[系统截断: 已节省 {chars} 字符历史，保留头尾共 {kept} 字；需要完整内容请用 offset/limit 或 grep 定位]…\n\n';

/**
 * 文本掐头去尾截断
 * @param {string} text 待截断文本
 * @param {number} maxChars 最大保留字数
 * @returns {{ text: string, removed: number }}
 */
export function trimText(text, maxChars = DEFAULT_MAX_CHARS) {
  const source = String(text ?? '');
  if (maxChars <= 0 || source.length <= maxChars) {
    return { text: source, removed: 0 };
  }

  const head = Math.ceil(maxChars * 0.6);
  const tail = maxChars - head;
  const removed = source.length - head - tail;

  const marker = TRIM_MARKER.replace('{chars}', String(removed)).replace('{kept}', String(head + tail));
  const result = source.slice(0, head) + marker + (tail > 0 ? source.slice(source.length - tail) : '');
  return { text: result, removed };
}

/**
 * 内容块数组裁剪（只动文本块，图片与其它类型绝对不碰）
 * @param {Array<object>} content 内容块列表
 * @param {number} maxChars 整体文本上限
 * @returns {{ content: Array<object>, removed: number }}
 */
export function trimContent(content, maxChars = DEFAULT_MAX_CHARS) {
  if (!Array.isArray(content) || content.length === 0) {
    return { content: content ?? [], removed: 0 };
  }

  let totalChars = 0;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      totalChars += block.text.length;
    }
  }

  if (totalChars <= maxChars) {
    return { content, removed: 0 };
  }

  let totalRemoved = 0;
  const out = content.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= 200) {
      return block;
    }
    // 超过 200 字的长文本块按比例裁剪
    const share = Math.floor((block.text.length / totalChars) * maxChars);
    const budget = Math.max(200, share);
    const { text, removed } = trimText(block.text, budget);
    totalRemoved += removed;
    return { ...block, text };
  });

  return { content: out, removed: totalRemoved };
}

/**
 * 长段落去重与折叠（用于折叠入站通道反复携带的模板文字）
 * @param {string} text 原文本
 * @param {Set<string>} seen 已见段落特征集合
 * @param {number} minChars 最小触发去重的字数
 * @returns {{ text: string, saved: number }}
 */
export function dedupeParagraphs(text, seen, minChars = 100) {
  const source = String(text ?? '');
  if (source.length < minChars || !seen) {
    return { text: source, saved: 0 };
  }

  const parts = source.split(/(\n{2,})/);
  let saved = 0;

  const rebuilt = parts.map(part => {
    if (/^\n+$/.test(part) || part.trim().length < minChars) {
      return part;
    }

    const trimmedPart = part.trim();
    // 取前 80 字符作为特征指纹
    const fingerprint = trimmedPart.slice(0, 80);

    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      return part;
    }

    // 已经见过，折叠后半部分
    const head = trimmedPart.slice(0, 40);
    const rest = trimmedPart.length - head.length;
    if (rest <= 40) return part; // 不划算就不折叠

    const folded = `${head}……[后 ${rest} 字符与前文相同，已自动折叠，未变]`;
    saved += trimmedPart.length - folded.length;
    return folded;
  });

  return { text: rebuilt.join(''), saved };
}
