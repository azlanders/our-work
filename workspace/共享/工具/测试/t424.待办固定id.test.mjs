import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 「补丁巡检」这类定时检查必须能销账。原来 `待办.mjs --加` 只给随机 id，
// 挂了之后谁也销不掉 —— 实测待办里躺着一条「快照对不上」，而快照早就一致了。
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 待办 = join(TOOLS, '待办.mjs')
const 补丁脚本 = '/root/运维服务/reapply-patches.sh'
// 这是肥鱼自己的运维脚本（二号机没有）。环境判断别用路径前缀 —— 同步脚本的
// 归一替换会把 `startsWith('{{BOT_ROOT}}')` 整体换掉，二号机会被当成一号机。
const 是肥鱼 = !TOOLS.includes('hajimi')


function 造() {
  const sb = mkdtempSync(join(tmpdir(), 'td419-'))
  return sb
}

function 跑(sb, args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [待办, ...args], {
        encoding: 'utf8', timeout: 30000, cwd: TOOLS,
        env: { ...process.env, TODO_FILE: join(sb, '待办.json') },
      }),
    }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 读 = (sb) => {
  const p = join(sb, '待办.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { items: [], done: [] }
}

test('P1 --id 固定：加两次只有一条，id 就是给的那个', () => {
  const sb = 造()
  跑(sb, ['--加', '补丁快照对不上', '--来源', '补丁巡检', '--id', '补丁快照'])
  跑(sb, ['--加', '补丁快照对不上', '--来源', '补丁巡检', '--id', '补丁快照'])
  const j = 读(sb)
  assert.equal(j.items.length, 1, '同一句话加了 ' + j.items.length + ' 条')
  assert.equal(j.items[0].id, '补丁快照', 'id 不是给的那个：' + j.items[0].id)
  rmSync(sb, { recursive: true, force: true })
})

test('P2 --好 <固定 id> 能销账（挪进 done）', () => {
  const sb = 造()
  跑(sb, ['--加', '补丁快照对不上', '--id', '补丁快照'])
  跑(sb, ['--好', '补丁快照'])
  const j = 读(sb)
  assert.equal(j.items.length, 0, '还挂在列表上')
  assert.equal(j.done.length, 1, '没进 done')
  assert.equal(j.done[0].id, '补丁快照', 'done 里的 id 不对')
  rmSync(sb, { recursive: true, force: true })
})

test('P3 销一个不存在的 id 不该炸（定时脚本每次都调，出错会留一堆 stderr）', () => {
  const sb = 造()
  const r = 跑(sb, ['--好', '根本不存在的id'])
  assert.equal(r.code, 0, '退出码不是 0：' + r.out)
  assert.ok(!/Error|Cannot read|stack/.test(r.out), '抛了异常：' + r.out.slice(0, 200))
  rmSync(sb, { recursive: true, force: true })
})

test('P4 不给 --id 时还是老行为（随机 id，不破坏手动加待办）', () => {
  const sb = 造()
  跑(sb, ['--加', '手动加的一条'])
  const j = 读(sb)
  assert.equal(j.items.length, 1)
  assert.match(j.items[0].id, /^t[0-9a-z]+$/, '老行为变了：' + j.items[0].id)
  rmSync(sb, { recursive: true, force: true })
})

test('P5 补丁巡检：不一致时用固定 id 挂，一致时调销账', { skip: !是肥鱼 && '二号机没有这个运维脚本' }, () => {
  // 这条锁的是脚本两头 —— 只挂不销，待办就会永远躺着一句过期的话。
  const s = readFileSync(补丁脚本, 'utf8')
  assert.match(s, /--加 [^\n]*--id 补丁快照/, '不一致时没用固定 id')
  assert.match(s, /--好 补丁快照/, '一致时没有销账 —— 那条「快照对不上」会永远挂在面板上')
})
