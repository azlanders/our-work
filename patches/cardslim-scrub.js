// 旧卡片里残留的整段运行快照就地压掉。
const SEQ_LINE = /^seq (\d+): (".*")$/;
export function scrubCardText(text) {
  const src = String(text || "");
  if (!src.includes("seq ")) return null;
  let changed = false;
  const out = src.split("\n").map((line) => {
    const match = SEQ_LINE.exec(line);
    if (!match) return line;
    let raw;
    try {
      raw = JSON.parse(match[2]);
    } catch {
      return line;
    }
    const slim = trimUserText(raw);
    if (slim === raw) return line;
    changed = true;
    return `seq ${match[1]}: ${JSON.stringify(slim)}`;
  });
  return changed ? out.join("\n") : null;
}
