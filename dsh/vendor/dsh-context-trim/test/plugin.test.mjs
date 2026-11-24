import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

class MockContext {
  constructor() {
    this.handlers = new Map();
  }
  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }
  async emit(event, arg, next = async () => arg) {
    const list = this.handlers.get(event) || [];
    let current = next;
    for (let i = list.length - 1; i >= 0; i--) {
      const fn = list[i];
      const prev = current;
      current = async (a) => fn(a ?? arg, prev);
    }
    return current(arg);
  }
}

test('apply: tools/post-execute 钩子截断长输出', async () => {
  const ctx = new MockContext();
  apply(ctx, { maxToolChars: 500 });

  const rawToolResult = {
    kind: 'accept',
    content: [{ type: 'text', text: 'OUTPUT_HEAD\n' + 'B'.repeat(3000) + '\nOUTPUT_TAIL' }]
  };

  const processed = await ctx.emit('tools/post-execute', rawToolResult, async () => rawToolResult);
  assert.equal(processed.kind, 'accept');
  assert.ok(processed.content[0].text.length < 1000);
  assert.ok(processed.content[0].text.startsWith('OUTPUT_HEAD'));
  assert.ok(processed.content[0].text.endsWith('OUTPUT_TAIL'));
  assert.ok(processed.content[0].text.includes('系统截断'));
});

test('apply: llm/stream 钩子改写指令变更', async () => {
  const ctx = new MockContext();
  apply(ctx, { enableDiff: true });

  // 真实场景：指令文件通常有几十条规则（上千字节）
  const rules = Array.from({ length: 30 }, (_, i) => `rule ${i + 1}: detailed policy description and safety boundaries for operation ${i + 1}`);
  const baseInstructions = rules.join('\n');
  const updatedRules = [...rules];
  updatedRules[15] = 'rule 16: MODIFIED policy description with extra precautions';
  const updatedInstructions = updatedRules.join('\n');

  const makeReq = (content) => ({
    messages: [
      {
        role: 'system',
        source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] },
        content: [{ type: 'text', text: content }]
      },
      { role: 'user', content: 'hello bot' }
    ]
  });

  // 第一次请求：建立 baseline，全量放行
  const req1 = makeReq(baseInstructions);
  const out1 = await ctx.emit('llm/stream', req1, async (opts) => opts);
  assert.equal(out1.messages[0].content[0].text, baseInstructions);

  // 第二次请求：指令内容微调，触发 Myers diff 增量替换
  const req2 = makeReq(updatedInstructions);
  const out2 = await ctx.emit('llm/stream', req2, async (opts) => opts);
  const rewritten = out2.messages[0].content[0].text;

  assert.ok(rewritten.includes('## AGENTS.md (变更 diff'));
  assert.ok(rewritten.includes('+ rule 16: MODIFIED policy description'));
  assert.ok(rewritten.includes('- rule 16: detailed policy description'));

  // 触发 compaction/done 重置 baseline
  await ctx.emit('compaction/done', {});

  // 重置后再次请求：重新全量放行
  const req3 = makeReq(updatedInstructions);
  const out3 = await ctx.emit('llm/stream', req3, async (opts) => opts);
  assert.equal(out3.messages[0].content[0].text, updatedInstructions);
});

test('apply: 收益守卫生效，当 diff 体积大于原文时不予改写', async () => {
  const ctx = new MockContext();
  apply(ctx, { enableDiff: true });

  const makeReq = (content) => ({
    messages: [
      {
        role: 'system',
        source: { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] },
        content: [{ type: 'text', text: content }]
      }
    ]
  });

  // 超小文件（只有几个字），diff 的 markdown 结构本身比原文大很多
  const smallBase = 'a = 1';
  const smallUpdate = 'a = 2';

  await ctx.emit('llm/stream', makeReq(smallBase), async (opts) => opts);
  const out = await ctx.emit('llm/stream', makeReq(smallUpdate), async (opts) => opts);

  // 收益守卫触发，依然全量放行原文
  assert.equal(out.messages[0].content[0].text, smallUpdate);
});

test('apply: fail-open 韧性测试，钩子抛错绝不影响主流程', async () => {
  const ctx = new MockContext();
  apply(ctx, {});

  // 传入非正常格式对象
  const weirdReq = { messages: null };
  const out = await ctx.emit('llm/stream', weirdReq, async () => ({ ok: true }));
  assert.equal(out.ok, true);
});
