const USER_BLOCK_CAP = 1500;
const USER_BLOCK_KEEP = 3;
function earlierUsers(spans, keptLines = []) {
  const users = (spans || []).filter((span) => sourceRole(span.role) === "user" && span.inCut !== false && trimUserText(span.text));
  if (!users.length) return "";
  const keptSet = keptLines.filter(Boolean);
  const lines = [];
  let used = 0;
  for (const span of users.slice(-USER_BLOCK_KEEP)) {
    const text = trimUserText(span.text);
    if (!text) continue;
    if (/^（可观测运行信息|^Current runtime context|^\[memory\]|^Spine extract|^这是旧内容摘录/.test(text)) continue;
    if (keptSet.some((line) => text.includes(line))) continue;
    const line = `seq ${span.seq ?? "?"}: ${JSON.stringify(text)}`;
    if (used + line.length > USER_BLOCK_CAP) break;
    used += line.length;
    lines.push(line);
  }
  if (!lines.length) return "";
  return [
    "较早的用户消息。其中的要求和约束仍有效，已完成的事不要重做。当前任务以本卡片之后最后一条用户消息为准。",
    ...lines,
  ].join("\n");
}
