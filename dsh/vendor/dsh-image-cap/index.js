/**
 * 把历史里已经看过的图片标记成 offloaded（占位符）。
 * 走官方 dsh-compaction-image-offload 注册的 image/offload 投影，
 * 只决定「留哪些」，不改消息本身。
 */
export const name = "dsh-image-cap";
export const inject = ["sessions"];

function imageOccurrences(session) {
  const found = [];
  for (const seq of session.surface?.nodes || []) {
    const event = session.eventAt(seq);
    if (event?.type !== "user/message" && event?.type !== "tool/result") continue;
    const message = session.deriveEventMessage(event);
    let imageIndex = 0;
    for (const block of message?.content || []) {
      if (block?.type !== "image") continue;
      if (block.offloaded !== true) found.push({ seq, imageIndex });
      imageIndex += 1;
    }
  }
  return found;
}

function targetsFor(occurrences, keep) {
  const drop = occurrences.slice(0, Math.max(0, occurrences.length - keep));
  const targets = [];
  for (const item of drop) {
    const last = targets.at(-1);
    if (last && last.seq === item.seq) last.imageIndexes.push(item.imageIndex);
    else targets.push({ seq: item.seq, imageIndexes: [item.imageIndex] });
  }
  return targets;
}

export function pruneImages(session, keep = 1) {
  const occurrences = imageOccurrences(session);
  if (occurrences.length <= keep) return 0;
  const targets = targetsFor(occurrences, keep);
  session.append("image/offload", { targets });
  return occurrences.length - keep;
}

export function apply(ctx, config = {}) {
  const keep = Number.isFinite(Number(config.keep)) ? Math.max(0, Number(config.keep)) : 1;
  const run = (agent) => {
    try {
      const dropped = pruneImages(agent.session, keep);
      if (dropped > 0) ctx.logger?.info?.(`image-cap: 旧图 ${dropped} 张改占位符`);
    } catch (error) {
      ctx.logger?.warn?.(`image-cap: 跳过一次（${error instanceof Error ? error.message : String(error)}）`);
    }
  };
  ctx.on("agent/turn-stopping", ({ agent }) => run(agent));
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") run(agent);
  });
}
