// turn-helpers.js —— 从 index.js 拆出的纯函数轮次边界判定（零副作用、零外部依赖）。

export function isCuttableTurnEnd(event) {
  const reason = event?.data?.reason;
  return reason?.kind === "completed" ||
    reason?.kind === "max-tokens" ||
    (reason?.kind === "other" && reason.label === "max-tokens");
}

export function latestTurnCompleted(events) {
  let lastStart = -1;
  let lastEnd = -1;
  let completed = false;
  for (let index = 0; index < (events || []).length; index += 1) {
    const event = events[index];
    if (event?.type === "turn/start") lastStart = index;
    if (event?.type === "turn/end") {
      lastEnd = index;
      completed = isCuttableTurnEnd(event);
    }
  }
  return lastEnd > lastStart && completed;
}

export function latestCompletedTurnEnd(events) {
  let found = null;
  for (const event of events || []) {
    if (event?.type === "turn/end" && isCuttableTurnEnd(event)) found = event;
  }
  return found;
}

export function latestTurnStart(events) {
  let found = null;
  for (const event of events || []) {
    if (event?.type === "turn/start") found = event;
  }
  return found;
}

export function turnStartForBoundary(events, boundary) {
  const list = events || [];
  const boundaryTurn = boundary?.data?.turn;
  const boundaryIndex = boundary?.seq == null
    ? -1
    : list.findIndex((event) => event?.seq === boundary.seq);
  let found = null;
  for (let index = 0; index < list.length; index += 1) {
    if (boundaryIndex >= 0 && index >= boundaryIndex) break;
    const event = list[index];
    if (event?.type !== "turn/start") continue;
    if (boundaryTurn !== undefined && event?.data?.turn !== boundaryTurn) continue;
    found = event;
  }
  return found;
}
