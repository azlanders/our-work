import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 批次437：把全套基线从「永远两个红」拉回 0 红。两条都是**测试自己的病**，跟生产代码无关。
//
//   t388.锁  写死 /tmp/sb388，t399.黑话 也是 —— 全套里两个文件是并行进程，
//            t399 在顶部一句 rmSync 就能把 t388 的锁目录删掉，于是「单跑绿、全套红」。
//   token_metrics  接口中转 11-12 起会自动挂 prompt cache 断点（PROMPT_CACHE_ANCHOR），
//            测试还按「原样转发」做 deep-equal，红的是测试过期。
//
// 这个文件不测功能，只盯「别退回去」。

const 测试目录 = '{{BOT_ROOT}}/共享/工具/测试'
const 测试文件 = readdirSync(测试目录).filter((f) => f.endsWith('.test.mjs'))

test('S1 所有测试的沙盒字面量路径必须唯一（并行进程会互相 rmSync）', () => {
  const 表 = new Map()
  for (const f of 测试文件) {
    const s = readFileSync(join(测试目录, f), 'utf8')
    // 只认「顶层常量 = '/tmp/xxx'」。mkdtemp 那种没有字面量，天然唯一，不在此列。
    const re = /^const\s+\S+\s*=\s*['"](\/tmp\/[^'"]+)['"]/gm
    let m
    while ((m = re.exec(s)) !== null) {
      const p = m[1]
      if (!表.has(p)) 表.set(p, [])
      表.get(p).push(f)
    }
  }
  const 撞 = [...表.entries()].filter(([, 谁]) => 谁.length > 1)
  assert.equal(撞.length, 0,
    '这些测试共用同一个沙盒路径，全套里会互相删：' + JSON.stringify(撞) +
    '  —— 改成 fs.mkdtempSync(path.join(os.tmpdir(), "前缀-"))')
})

test('S2 t388 / t399 必须用 mkdtemp，不许退回写死路径', () => {
  for (const f of ['t388.锁.test.mjs', 't399.黑话.test.mjs']) {
    const s = readFileSync(join(测试目录, f), 'utf8')
    assert.match(s, /mkdtempSync\(/, f + ' 又用回写死的沙盒路径了')
    assert.doesNotMatch(s, /^const\s+\S+\s*=\s*['"]\/tmp\//m, f + ' 里又出现了 /tmp/ 字面量沙盒')
  }
})

test('S3 token_metrics 的转发断言必须容许 cache 断点（别退回「原样转发」）', () => {
  const s = readFileSync(join(测试目录, 'token_metrics.test.mjs'), 'utf8')
  // 旧写法就是这一句 —— 它红是因为中转会自动挂 cache_control，不是转发坏了
  assert.doesNotMatch(s, /assert\.deepEqual\(forwarded,\{\.\.\.request,model:'actual'\}\)/,
    '退回原样转发的断言了 —— 全套会重新红，而那条红是假的')
  assert.match(s, /剥断点/, '连「剥掉断点再比」这一步都没了')
  assert.match(s, /点数\s*<=\s*4/, '断点上限（上游 4 个）没钉')
})

test('S5 真跑 心跳.mjs --tick 的测试必须隔离锁目录', () => {
  // 生产 crontab 每分钟跑一次 `心跳.mjs --tick`，它抢一把叫 'heartbeat' 的锁，
  // 而 _锁.mjs 的目录读 QQ_LOCK_DIR（不设就是真档）。跑 --tick 的测试若不隔离，
  // 就是在跟生产抢锁 —— `strict: true` 抢不到就整轮跳过，测试时红时绿。
  //
  // 只认**心跳**的两种跑法。刷手机/怨/打盹也有 --tick，跟这把锁无关 ——
  // 第一版判据写的是「文件里含 '--tick'」，于是把 t420 的怨.mjs 也抓进来了。
  const 真跑 = 测试文件.filter((f) => {
    const s = readFileSync(join(测试目录, f), 'utf8')
    return /\[心跳\s*,\s*'--tick'/.test(s) || /跑一轮\(\s*\['--tick'/.test(s)
  })
  assert.ok(真跑.length > 0, '一个跑心跳 --tick 的测试都没找到？那 S5 失效了')
  for (const f of 真跑) {
    const s = readFileSync(join(测试目录, f), 'utf8')
    assert.match(s, /QQ_LOCK_DIR/, f + ' 跑心跳 --tick 却没设 QQ_LOCK_DIR —— 会和生产抢锁')
  }
})
