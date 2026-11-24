// t472 补丁快照必须跟线上 lib 一致（否则插件一重装就退回旧代码）
//
// 起因（批次472）：待办里挂了一整天「补丁快照和线上 lib 对不上」，没人看见；
// 查下来线上 lib 有 12 个文件跟 /root/onebot-patches 的快照不一致（快照停在 11-05），
// 而 `reapply-patches.sh` 不带参数就是「覆盖恢复 + 重启」—— 一重装就把这些天的改动盖回去，还不报错。
// 已 --save 刷新，并在 契约检查 里加了一条闸（第 84 条）。这个测试钉住那条闸。
//
// 跑法：node --test t472.补丁快照.test.mjs

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const 契约 = join(工具, '契约检查.mjs')
const 补丁脚本 = '/root/运维服务/reapply-patches.sh'
// REAPPLY_ENV 2026-11-24：脚本已改成「不给 DSH_HOME 就拒绝猜路径」（原来默认写死
// 某个别家实例的 DSH 根，照默认跑会去恢复别人家的插件）。所以调用方必须显式给实例根。
// 这里从 QQ_PLUGIN_LIB（…/profiles/web/node_modules/<pkg>/lib）上溯；
// 没设就按 DSH_HOME 环境变量，再不行用本机默认。
const 实例根 = (() => {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const lib = process.env.QQ_PLUGIN_LIB
    || (process.env.BOT_ROOT ? process.env.BOT_ROOT : '') + ''
  const m = String(lib).match(/^(.*?)\/profiles\//)
  if (m) return m[1]
  return '{{DSH_ROOT}}'
})()

test('A1 契约里要有这一条（钉住关键字与脚本路径）', () => {
  const s = readFileSync(契约, 'utf8')
  assert.match(s, /插件补丁快照跟线上 lib 一致/, '契约里没有这一条 —— 快照过期没人拦')
  assert.match(s, /reapply-patches\.sh/, '没调 reapply-patches.sh')
  assert.match(s, /--check/, '没走 --check（只比不动的那个模式）')
})

test('A2 现在快照是一致的（--check 退出码 0）', () => {
  let 码 = 0
  let 出 = ''
  try {
    // 成功时也要把输出收下来 —— 第一版只在 catch 里取，成功路径 出 永远是空串，断言当场假红
    出 = execFileSync('bash', [补丁脚本, '--check'],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, DSH_HOME: 实例根 } })
  } catch (e) {
    码 = (e && typeof e.status === 'number') ? e.status : -1
    出 = String((e && (e.stdout || e.stderr)) || '')
  }
  assert.equal(码, 0, '快照跟线上 lib 不一致：\n' + 出.slice(-400))
  assert.match(出, /ok|一致/, '--check 没说一致性结论：' + 出.slice(-200))
})

test('A3 契约的通过项数要不低于 643（删掉那一条会掉下来）', () => {
  const out = execFileSync(process.execPath, [契约], { encoding: 'utf8', timeout: 180000 })
  const m = out.match(/契约检查：(\d+) 项通过 \/ (\d+) 项不对/)
  assert.ok(m, '没解析到契约汇总：' + out.slice(-300))
  const 通过 = Number(m[1])
  const 不对 = Number(m[2])
  assert.equal(不对, 0, '契约有 ' + 不对 + ' 项不对：\n' + out.slice(-600))
  assert.ok(通过 >= 643, '通过项只有 ' + 通过 + '（基线 643）—— 是不是有人把某条删了')
})
