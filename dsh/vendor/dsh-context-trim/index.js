/**
 * dsh-context-trim — 哈基米上下文瘦身与增量差分插件
 *
 * 为真实 QQ 机器人拟人化生产环境量身定制：
 * 1. 【超长工具输出入口裁剪】：对 bash、文件读取等产生的海量输出进行截断（保留头尾结构），
 *    阻断无用冗余字符进入历史会话产生的指数级复利 token 膨胀；
 * 2. 【指令文件 Myers 增量差分】：在 AGENTS.md / 规则修改时仅发送行级 diff 锚点，杜绝全文重复堆叠；
 * 3. 【QQ 核心工具链零干扰保证】：绝不动态 restrict 工具名单，绝对保障 qq_send / memory_recall 等可见性，
 *    不扰动底层 Prompt Cache 前缀缓存；
 * 4. 【零并发锁干扰】：不主动触发 compactNow，与外部 dsh-live-compact 和谐共存。
 *
 * @license MIT
 */

import { trimContent, trimText, DEFAULT_MAX_CHARS } from './lib/trim.js';
import { diffLines, renderDiff, normalizeEol } from './lib/diff.js';

export const name = 'dsh-context-trim';
export const inject = [];

export function apply(ctx, rawConfig = {}) {
  const config = {
    enabled: rawConfig.enabled ?? true,
    maxToolChars: Number(rawConfig.maxToolChars) || DEFAULT_MAX_CHARS,
    enableTrim: rawConfig.enableTrim ?? true,
    enableDiff: rawConfig.enableDiff ?? true,
    debug: rawConfig.debug ?? false,
  };

  if (!config.enabled) {
    return;
  }

  const log = (msg) => {
    if (config.debug) {
      try {
        process.stderr.write(`[context-trim] ${msg}\n`);
      } catch { /* ignore */ }
    }
  };

  /**
   * 1. 工具结果入口裁剪 (tools/post-execute)
   * 无论工具输出几万字，在进入 session 历史前掐头去尾，留存关键头尾结构
   */
  if (config.enableTrim) {
    ctx.on('tools/post-execute', async (event, next) => {
      try {
        const result = await next();
        if (!result || !Array.isArray(result.content)) {
          return result;
        }

        const { content: trimmedContent, removed } = trimContent(result.content, config.maxToolChars);
        if (removed > 0) {
          log(`裁剪工具输出: 已削减 ${removed} 字符历史污染`);
          return { ...result, content: trimmedContent };
        }
        return result;
      } catch (err) {
        // fail-open: 任何错误放行原结果
        log(`tools/post-execute 异常放行: ${err?.message || err}`);
        return next();
      }
    });
  }

  /**
   * 2. 指令文件行级增量差分 (llm/stream)
   * 内存维护各文件 baseline，修改时只推差分
   */
  if (config.enableDiff) {
    /** @type {Map<string, string>} filePath -> lastBaseline */
    const baselines = new Map();

    ctx.on('llm/stream', async (options, next) => {
      try {
        const messages = options?.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return next(options);
        }

        // 查找最后一条 agent-instructions 消息
        const lastIdx = messages.findLastIndex?.(m => m?.source?.kind === 'agent-instructions')
          ?? (() => {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i]?.source?.kind === 'agent-instructions') return i;
            }
            return -1;
          })();

        if (lastIdx === -1) {
          return next(options);
        }

        const msg = messages[lastIdx];
        const changes = msg.source?.changes;
        if (!Array.isArray(changes) || changes.length === 0) {
          return next(options);
        }

        // 提取消息纯文本
        const rawContent = Array.isArray(msg.content)
          ? msg.content.filter(b => b?.type === 'text').map(b => b.text).join('')
          : (typeof msg.content === 'string' ? msg.content : '');

        if (!rawContent) {
          return next(options);
        }

        let canDiff = true;
        const diffSections = [];

        for (const item of changes) {
          const filePath = String(item?.path ?? 'instruction');
          const currentText = normalizeEol(rawContent);
          const prevBaseline = baselines.get(filePath);

          if (!prevBaseline) {
            // 首次加载：建立基准并全量发送
            baselines.set(filePath, currentText);
            canDiff = false;
            break;
          }

          if (prevBaseline === currentText) {
            // 内容无变化
            continue;
          }

          const diffRes = diffLines(prevBaseline, currentText);
          const rendered = renderDiff(filePath, diffRes, currentText.split('\n').length);
          const renderedBytes = Buffer.byteLength(rendered, 'utf8');
          const fullBytes = Buffer.byteLength(currentText, 'utf8');

          if (renderedBytes >= fullBytes) {
            // 收益守卫：差分若大于等于原文，直接全量并推进基准
            baselines.set(filePath, currentText);
            canDiff = false;
            break;
          }

          diffSections.push({ filePath, rendered, currentText });
        }

        if (!canDiff || diffSections.length === 0) {
          return next(options);
        }

        // 满足差分收益条件：改写此条指令消息为 diff
        for (const section of diffSections) {
          baselines.set(section.filePath, section.currentText);
        }

        const diffBody = diffSections.map(s => s.rendered).join('\n\n');
        const nextMessages = messages.slice();
        nextMessages[lastIdx] = {
          ...msg,
          content: [{ type: 'text', text: diffBody }],
        };

        log(`指令增量差分生效: ${diffSections.map(s => s.filePath).join(', ')}`);
        return next({ ...options, messages: nextMessages });
      } catch (err) {
        // fail-open 保护
        log(`llm/stream 差分异常放行: ${err?.message || err}`);
        return next(options);
      }
    });

    // 会话压缩时清除 baseline，防止新会话基于旧基准导致模型丢失全量信息
    ctx.on('compaction/done', () => {
      baselines.clear();
      log('会话压缩已触发，清除指令基准以备重置');
    });
  }

  log('dsh-context-trim 生产级插件加载完毕');
}

export const __test = { trimContent, trimText, diffLines, renderDiff, normalizeEol };
