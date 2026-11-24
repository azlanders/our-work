import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 心跳失败原来只写 心跳.log，而 目录卫生 把日志裁到 2500 行 —— 一分钟一行，
// 1.7 天就滚没了。「某个任务连着失败」过两天完全没有痕迹。
// 这里锁的是：高频任务连败 3 次才报、日级任务失败 1 次就报、恢复后自动销账、
// 不会重复挂。
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 心跳 = join(TOOLS, '心跳.mjs')

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 'hb419-'))
  mkdirSync(join(sb, '日志'), { recursive: true })
  // LOCK_ISOLATE 2026-11-14（批次437）：心跳的调度锁叫 'heartbeat'，而 _锁.mjs 的目录
  // 读 QQ_LOCK_DIR —— 不设就是真档那个。生产 crontab 每分钟真跑一次 --tick，
  // 测试子进程跟它抢同一把锁，`strict: true` 抢不到就「跳过本轮」，
  // H2/H3 于是时红时绿（撞上生产那一分钟就红）。沙盒的锁必须自己一份。
  mkdirSync(join(sb, '锁'), { recursive: true })
  writeFileSync(join(sb, '坏.mjs'), "console.error('我是故意坏的')\nprocess.exit(1)\n")
  writeFileSync(join(sb, '好.mjs'), "console.log('好了')\n")
  return sb
}

function 写表(sb, 任务们) {
  writeFileSync(join(sb, '表.json'), JSON.stringify(任务们, null, 1))
}

function 跑(sb) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [心跳, '--tick', '--表', join(sb, '表.json')], {
        encoding: 'utf8', timeout: 60000, cwd: TOOLS,
        env: {
          ...process.env,
          FISH_SANDBOX_DIR: sb,
          QQ_LOCK_DIR: join(sb, '锁'),
          TODO_FILE: join(sb, '待办.json'),
          心跳_重入毫秒: '0', // 0 是合法值：这个变量曾被 `|| 50000` 吃掉
        },
      }),
    }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 待办们 = (sb) => {
  const p = join(sb, '待办.json')
  if (!existsSync(p)) return { items: [], done: [] }
  return JSON.parse(readFileSync(p, 'utf8'))
}
const 连败 = (sb) => {
  const p = join(sb, '.心跳连败.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}
// 每天任务必须写「现在」的时和分才会命中
const 北京时分 = () => {
  const d = new Date(Date.now() + 8 * 3600e3)
  return { 时: d.getUTCHours(), 分: d.getUTCMinutes() }
}

test('H1 高频任务：失败 1、2 次不打扰，第 3 次才挂', () => {
  const sb = 造()
  写表(sb, [{ 名: '高频坏', 脚本: '坏.mjs', 间隔分: 1, 日志: '高频坏.log' }])
  for (let i = 1; i <= 2; i++) {
    跑(sb)
    assert.equal(待办们(sb).items.length, 0, '第 ' + i + ' 次就挂了 —— 4.5% 的偶发失败会变成天天报警')
    assert.equal(连败(sb)['高频坏'].连败, i, '连败没累计到 ' + i)
  }
  跑(sb)
  const j = 待办们(sb)
  assert.equal(j.items.length, 1, '第 3 次没挂待办')
  assert.match(j.items[0].id, /高频坏/, '待办 id 里没有任务名：' + j.items[0].id)
  assert.match(j.items[0].事项, /连着失败 3 次/, '事项没说清失败几次：' + j.items[0].事项)
  assert.match(j.items[0].事项, /退出码 1/, '事项没带失败原因：' + j.items[0].事项)
  assert.equal(j.items[0].来源, '心跳', '来源不对：' + j.items[0].来源)
  rmSync(sb, { recursive: true, force: true })
})

test('H2 继续失败不重复挂（面板上只该有一条）', () => {
  const sb = 造()
  写表(sb, [{ 名: '高频坏', 脚本: '坏.mjs', 间隔分: 1 }])
  for (let i = 0; i < 6; i++) 跑(sb)
  assert.equal(待办们(sb).items.length, 1, '同一条失败挂了多份：' + JSON.stringify(待办们(sb).items.map((x) => x.id)))
  assert.equal(连败(sb)['高频坏'].连败, 6, '连败没数到 6')
  rmSync(sb, { recursive: true, force: true })
})

test('H3 恢复一次就销账（谁=自动），连败归零', () => {
  const sb = 造()
  写表(sb, [{ 名: '时好时坏', 脚本: '坏.mjs', 间隔分: 1 }])
  for (let i = 0; i < 3; i++) 跑(sb)
  assert.equal(待办们(sb).items.length, 1, '先得挂上')
  // 换成好脚本
  写表(sb, [{ 名: '时好时坏', 脚本: '好.mjs', 间隔分: 1 }])
  跑(sb)
  const j = 待办们(sb)
  assert.equal(j.items.length, 0, '恢复了还挂在面板上')
  assert.equal(j.done.length, 1, '没挪进 done')
  assert.equal(j.done[0].谁, '自动', '销账的「谁」应该是自动')
  assert.equal(连败(sb)['时好时坏'].连败, 0, '连败没归零')
  assert.ok(连败(sb)['时好时坏'].最后成功, '没记最后成功时刻')
  rmSync(sb, { recursive: true, force: true })
})

test('H4 日级任务失败一次就报（下次机会在一天后，等三次等于三天后才知道）', () => {
  const sb = 造()
  const { 时, 分 } = 北京时分()
  写表(sb, [{ 名: '每日坏', 脚本: '坏.mjs', 每天: true, 时, 分 }])
  跑(sb)
  const j = 待办们(sb)
  assert.equal(j.items.length, 1, '每天一次的任务失败一次没报 —— 三天后才知道它停了')
  assert.match(j.items[0].事项, /连着失败 1 次/, '事项不对：' + j.items[0].事项)
  rmSync(sb, { recursive: true, force: true })
})

test('H5 没命中的任务不记账（账里不该有它）', () => {
  const sb = 造()
  // 12 小时后那个一定不命中（时不同，不会跨回同一个钟点）
  const { 时, 分 } = 北京时分()
  写表(sb, [
    { 名: '半天后才跑', 脚本: '坏.mjs', 每天: true, 时: (时 + 12) % 24, 分 },
    { 名: '高频坏', 脚本: '坏.mjs', 间隔分: 1 },
  ])
  跑(sb)
  const 账 = 连败(sb)
  assert.ok(账['高频坏'], '命中那條没记账')
  assert.equal(账['半天后才跑'], undefined, '没命中的任务也记账了 —— 账会越来越脏')
  rmSync(sb, { recursive: true, force: true })
})

test('H6 失败行仍然写进 心跳.log（日志没被这次的待办取代）', () => {
  const sb = 造()
  写表(sb, [{ 名: '高频坏', 脚本: '坏.mjs', 间隔分: 1, 日志: '子.log' }])
  跑(sb)
  const log = readFileSync(join(sb, '日志', '心跳.log'), 'utf8')
  assert.match(log, /\[失败\] 高频坏 退出码 1/, '心跳.log 里没有失败行：' + log.slice(-200))
  rmSync(sb, { recursive: true, force: true })
})

test('H7 继续失败时不反复改事项（面板上那句不该每分钟变一次）', () => {
  // 「后 === 阈值」而不是「>=」：只挂一次。改成 >= 不会多出条目（同步是幂等的），
  // 但事项里的「连着失败 N 次」会每轮跟着涨，面板上那句话一直在跳。
  const sb = 造()
  写表(sb, [{ 名: '高频坏', 脚本: '坏.mjs', 间隔分: 1 }])
  for (let i = 0; i < 5; i++) 跑(sb)
  const 事项 = 待办们(sb).items[0].事项
  assert.match(事项, /连着失败 3 次/, '挂了之后事项还在跟着涨：' + 事项)
  rmSync(sb, { recursive: true, force: true })
})
