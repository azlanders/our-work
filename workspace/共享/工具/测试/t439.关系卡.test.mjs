import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次439：关系卡是「每回合都带」的那段（deliver.js 写进正文，不像状态段走 systemPrompt.context），
// 所以它的长度直接等于每轮的固定成本。原来清理了一遍：
//   9 条 653 字 → 6 条 445 字（删掉一条已被下一条作废的、一条重复的、一条「已修好的 bug 单」）。
// 同时发现两件事没人管：
//   ① 装不下就整条跳过 —— 而「她记住了、却读不到」一声不响；
//   ② `qq_remember` 什么都能记，于是「系统哪个提示有 bug」也被记进了「关于他」。
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const MEMORY = LIB + '/memory.js'

// 第二参数是额外 env：DSH_DATA 指到沙盒 —— 否则 note() 会往**真** load.log 里写
// 「关系卡装不下」，跟真的报警一样，跑一次全套污染两条（env.js 的 DATA_SANDBOX 就是为这个加的）。
function 跑(脚本, env = {}) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 脚本], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...env },
  })
  return out.trim().split('\n').pop()
}

test('B1 装不下时注入严格不超上限（整条跳过，不切半句）', () => {
  const sb = mkdtempSync(join(tmpdir(), 'mem439-'))
  try {
    const p = join(sb, 'card.json')
    // 10 条 × 200 字 = 2000 字，上限 1000
    const facts = []
    for (let i = 1; i <= 10; i += 1) {
      facts.push({ at: 1700000000000 + i, text: '第' + i + '条' + '啊'.repeat(197) })
    }
    writeFileSync(p, JSON.stringify({ 'private:x': { facts } }))
    const 代码 = `
      const m = await import(${JSON.stringify(MEMORY)})
      m.useMemoryFile(${JSON.stringify(p)})
      const c = m.describeMemory('private:x', { ownerKey: 'private:x' })
      console.log(JSON.stringify({ len: c.length, text: c }))
    `
    const o = JSON.parse(跑(代码, { DSH_DATA: join(sb, '.dsh') }))
    // 包装「（关于他：称呼：…；记得：…）」约 20 字，留 60 的余量
    assert.ok(o.len <= 1000 + 60, '装超了：' + o.len + ' 字')
    // 整条装填：每一段都必须是完整的一条，不能出现「啊」被切在半句
    assert.doesNotMatch(o.text, /…/, '出现了省略号 —— 有条目被切半句了')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('B2 装不下时优先装新的（从后往前装，旧的先丢）', () => {
  const sb = mkdtempSync(join(tmpdir(), 'mem439b-'))
  try {
    const p = join(sb, 'card.json')
    const facts = []
    for (let i = 1; i <= 10; i += 1) {
      facts.push({ at: 1700000000000 + i, text: '第' + i + '条' + '啊'.repeat(197) })
    }
    writeFileSync(p, JSON.stringify({ 'private:x': { facts } }))
    const 代码 = `
      const m = await import(${JSON.stringify(MEMORY)})
      m.useMemoryFile(${JSON.stringify(p)})
      console.log(JSON.stringify({ text: m.describeMemory('private:x', { ownerKey: 'private:x' }) }))
    `
    const o = JSON.parse(跑(代码, { DSH_DATA: join(sb, '.dsh') }))
    assert.match(o.text, /第10条/, '最新的那条反而没进去')
    assert.doesNotMatch(o.text, /第1条/, '最老的那条不该占位置（装不下时该先丢它）')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('B3 装不下必须留痕（原来一声不响）', () => {
  const s = readFileSync(MEMORY, 'utf8')
  assert.match(s, /关系卡装不下/, '「跳过几条」的日志被删了 —— 她又变成「记住了但读不到」还没人知道')
  assert.match(s, /有效条/, '只在非空条目里算 —— 空 text 被 continue 掉，不该算作装不下')
})

test('B4 「上次跳过数」的初值不能是 0（0 是合法值：装得下）', () => {
  const s = readFileSync(MEMORY, 'utf8')
  assert.match(s, /let __上次跳过 = -1/,
    '初值写成 0 的话，「第一次跑就装得下」和「从来没跑过」分不开 —— 这是 `Number(0) || 默认` 那个老病')
})

test('B5 qq_remember 的描述必须写明「只记他的事」', () => {
  const s = readFileSync(LIB + '/tool.js', 'utf8')
  const i = s.indexOf("name: 'qq_remember'")
  assert.ok(i > 0, '找不到 qq_remember')
  const 段 = s.slice(i, i + 1200)
  // 这三句是一组，各挡一个方向，缺一句就漏一个口子：
  //   「只记他的事」—— 正面说清记什么；
  //   「都别记这儿」—— 反面挡住「自己的教训 / 系统毛病」；
  //   点名 bug —— 因为卡里真的躺过一条「已给相册提示加上…」，那是给她记的 bug 单。
  //
  // 第一版只查「关于他」「别记这儿」「bug」三个词 —— 把「只记他的事」整句改成「什么都可以记」
  // 反测竟然还是绿的（另外两个词还在）。断言用关键词时，同义表达有好几处就抓不住。
  assert.match(段, /只记他的事/, '没写清「记的是他的事」')
  assert.match(段, /都别记这儿/, '没有「什么不该记」的边界')
  assert.match(段, /bug/, '没点名「系统 bug / 代码改动」这类不该记进来')
})
