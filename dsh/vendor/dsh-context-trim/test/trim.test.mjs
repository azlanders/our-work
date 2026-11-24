import test from 'node:test';
import assert from 'node:assert/strict';
import { trimText, trimContent, dedupeParagraphs } from '../lib/trim.js';

test('trimText: 短文本不截断', () => {
  const short = 'hello world!';
  const res = trimText(short, 100);
  assert.equal(res.text, short);
  assert.equal(res.removed, 0);
});

test('trimText: 长文本截断并保留头尾结构', () => {
  const longText = 'HEADER_LINE_START\n' + 'X'.repeat(5000) + '\nTAIL_LINE_END';
  const res = trimText(longText, 1000);
  assert.equal(res.removed, 5000 + 18 + 14 - 1000);
  assert.ok(res.text.startsWith('HEADER_LINE_START'));
  assert.ok(res.text.endsWith('TAIL_LINE_END'));
  assert.ok(res.text.includes('系统截断: 已节省'));
});

test('trimContent: 图片与自定义块绝对不被损坏', () => {
  const blocks = [
    { type: 'image', data: 'base64_data_xyz', mime: 'image/png' },
    { type: 'text', text: 'START ' + 'A'.repeat(4000) + ' END' },
    { type: 'custom', payload: { foo: 'bar' } }
  ];

  const res = trimContent(blocks, 1000);
  assert.equal(res.content.length, 3);
  assert.equal(res.content[0].type, 'image');
  assert.equal(res.content[0].data, 'base64_data_xyz');
  assert.equal(res.content[2].type, 'custom');
  assert.deepEqual(res.content[2].payload, { foo: 'bar' });

  // 文本块被削减
  assert.ok(res.content[1].text.length < 2000);
  assert.ok(res.removed > 2000);
});

test('dedupeParagraphs: 识别并折叠重复入站段落', () => {
  const seen = new Set();
  const boilerplate = '专属通道指令规范：请务必遵守机器人人设与行为守则，不要越界，严格按格式输出回复。'.repeat(5);

  const firstPass = dedupeParagraphs(boilerplate, seen, 50);
  assert.equal(firstPass.saved, 0, '首发段落原样保留');

  const secondPass = dedupeParagraphs(boilerplate, seen, 50);
  assert.ok(secondPass.saved > 0, '二次出现段落被成功折叠');
  assert.ok(secondPass.text.includes('已自动折叠'));
});
