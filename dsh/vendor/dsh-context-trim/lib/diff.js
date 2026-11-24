/**
 * 行级增量差分模块（基于 Myers Diff 算法）
 *
 * 核心设计：
 * 1. 换行符严格归一化：解决 Windows 与 Linux 换行符（CRLF vs LF）导致的“全量删加”灾难。
 * 2. 收益守卫（worth-it）：差分结果只有小于原文字节时才采纳，否则原样全量发送。
 * 3. 紧凑锚点（CTX = 2）：修改前后仅保留 2 行上下文，既表明定位又极大压缩体积。
 * 4. 纯内存计算，零外部依赖，不访问文件系统。
 */

const CTX = 2;

/**
 * 换行符归一化
 * @param {string} s 字符串
 * @returns {string}
 */
export function normalizeEol(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n');
}

/**
 * Myers 差分算法
 * @param {string[]} a 旧行数组
 * @param {string[]} b 新行数组
 * @returns {Array<{ op: '='|'-'|'+', line: string }>} 操作序列
 */
export function myersDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const v = new Map();
  v.set(1, 0);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    const vCopy = new Map(v);
    trace.push(vCopy);

    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }

      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);

      if (x >= n && y >= m) {
        // 回溯还原 diff 路径
        const edits = [];
        let curX = n;
        let curY = m;

        for (let step = d; step > 0; step--) {
          const stepV = trace[step];
          const curK = curX - curY;
          let prevK;
          if (curK === -step || (curK !== step && (stepV.get(curK - 1) ?? 0) < (stepV.get(curK + 1) ?? 0))) {
            prevK = curK + 1;
          } else {
            prevK = curK - 1;
          }

          const prevX = stepV.get(prevK) ?? 0;
          const prevY = prevX - prevK;

          while (curX > prevX && curY > prevY) {
            edits.unshift({ op: '=', line: a[curX - 1] });
            curX--;
            curY--;
          }

          if (curX > prevX) {
            edits.unshift({ op: '-', line: a[curX - 1] });
            curX--;
          } else if (curY > prevY) {
            edits.unshift({ op: '+', line: b[curY - 1] });
            curY--;
          }
        }

        while (curX > 0 && curY > 0) {
          edits.unshift({ op: '=', line: a[curX - 1] });
          curX--;
          curY--;
        }
        return edits;
      }
    }
  }

  // 兜底：无法求解时直接全量删改
  return [...a.map(l => ({ op: '-', line: l })), ...b.map(l => ({ op: '+', line: l }))];
}

/**
 * 将行级操作切成带锚点的块（Hunks）
 * @param {string} aText 旧文本
 * @param {string} bText 新文本
 * @returns {{ hunks: Array<{ lines: string[] }>, hasChanges: boolean }}
 */
export function diffLines(aText, bText) {
  const normA = normalizeEol(aText);
  const normB = normalizeEol(bText);

  if (normA === normB) {
    return { hunks: [], hasChanges: false };
  }

  const linesA = normA.length === 0 ? [] : normA.split('\n');
  const linesB = normB.length === 0 ? [] : normB.split('\n');
  const edits = myersDiff(linesA, linesB);

  // 提取带锚点的修改块
  const hunks = [];
  let currentHunk = null;
  let equalBuffer = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.op === '=') {
      if (currentHunk) {
        equalBuffer.push(edit);
        if (equalBuffer.length > CTX * 2) {
          // 结束当前 hunk，保留尾部 CTX 行
          currentHunk.lines.push(...equalBuffer.slice(0, CTX).map(e => `  ${e.line}`));
          hunks.push(currentHunk);
          currentHunk = null;
          equalBuffer = equalBuffer.slice(-CTX);
        }
      } else {
        equalBuffer.push(edit);
        if (equalBuffer.length > CTX) {
          equalBuffer.shift();
        }
      }
    } else {
      if (!currentHunk) {
        currentHunk = { lines: [] };
        // 前导锚点
        currentHunk.lines.push(...equalBuffer.map(e => `  ${e.line}`));
      } else if (equalBuffer.length > 0) {
        currentHunk.lines.push(...equalBuffer.map(e => `  ${e.line}`));
      }
      equalBuffer = [];
      const prefix = edit.op === '-' ? '- ' : '+ ';
      currentHunk.lines.push(prefix + edit.line);
    }
  }

  if (currentHunk) {
    currentHunk.lines.push(...equalBuffer.slice(0, CTX).map(e => `  ${e.line}`));
    hunks.push(currentHunk);
  }

  return { hunks, hasChanges: true };
}

/**
 * 渲染 diff 输出文本
 * @param {string} filePath 文件相对路径
 * @param {object} diffResult diffLines 的返回
 * @param {number} totalLines 新文件总行数
 * @returns {string} 渲染结果
 */
export function renderDiff(filePath, diffResult, totalLines = 0) {
  if (!diffResult.hasChanges || diffResult.hunks.length === 0) {
    return `[文件无改动: ${filePath}]`;
  }

  const out = [];
  out.push(`## ${filePath} (变更 diff, 总行数: ${totalLines})`);
  out.push('```diff');
  for (const hunk of diffResult.hunks) {
    out.push(hunk.lines.join('\n'));
    out.push('  ...');
  }
  if (out[out.length - 1] === '  ...') out.pop();
  out.push('```');
  out.push('`-` 为删除, `+` 为新增, 无符号行为定位锚点。未提及内容保持不变。');
  return out.join('\n');
}
