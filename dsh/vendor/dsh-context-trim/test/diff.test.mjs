import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEol, diffLines, renderDiff } from '../lib/diff.js';

test('normalizeEol: 正确归一化 CRLF / CR 到 LF', () => {
  const mixed = 'line1\r\nline2\rline3\n';
  assert.equal(normalizeEol(mixed), 'line1\nline2\nline3\n');
});

test('diffLines: 相同内容无改动', () => {
  const text = 'line 1\nline 2\nline 3\n';
  const diff = diffLines(text, text);
  assert.equal(diff.hasChanges, false);
  assert.equal(diff.hunks.length, 0);
});

test('diffLines: CRLF 与 LF 比较判定为相同（杜绝虚假全量删加）', () => {
  const crlf = 'line 1\r\nline 2\r\nline 3\r\n';
  const lf = 'line 1\nline 2\nline 3\n';
  const diff = diffLines(crlf, lf);
  assert.equal(diff.hasChanges, false);
});

test('diffLines: 产生带定位锚点的增量修改块', () => {
  const oldText = 'a\nb\nc\nd\ne\nf';
  const newText = 'a\nb\nC_MODIFIED\nd\ne\nf';
  const diff = diffLines(oldText, newText);

  assert.equal(diff.hasChanges, true);
  assert.equal(diff.hunks.length, 1);
  const hunkText = diff.hunks[0].lines.join('\n');
  assert.ok(hunkText.includes('- c'));
  assert.ok(hunkText.includes('+ C_MODIFIED'));
  // 上下文锚点行
  assert.ok(hunkText.includes('  a') || hunkText.includes('  b'));
});

test('renderDiff: 正确输出 Markdown 格式的清晰 diff 块', () => {
  const oldText = 'rule 1\nrule 2\nrule 3';
  const newText = 'rule 1\nrule 2 revised\nrule 3';
  const diff = diffLines(oldText, newText);
  const rendered = renderDiff('AGENTS.md', diff, 3);

  assert.ok(rendered.includes('## AGENTS.md'));
  assert.ok(rendered.includes('```diff'));
  assert.ok(rendered.includes('+ rule 2 revised'));
  assert.ok(rendered.includes('- rule 2'));
});
