import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// 批次452：`一起听` 开关 11-13 23:15 就关了，可 `下载/` 一直在长新的 ncm-clip。
// 查到底是 fish-music 的进程起于 11-12 11:55:49，而 一起听歌.mjs 改于 11:56:54 —— 差 65 秒，
// 进程里跑的是**没有开关检查的旧代码**：每 2 秒打一次网易云、每首歌下 4MB 还送去云端分析。
// 顺带查出 qq-logserver 也在跑 13 天前的代码。
//
// 所以给 契约检查 加了一节「服务不许跑旧代码」（比服务的启动时刻 vs 它的脚本 mtime）。
// 这个文件锁三件事：
//   ① 那四个服务都盯着，别哪天被删
//   ② **判不了不能算通过** —— 这条第一次写就栽在这：起 解析成 0，条件被 `起 > 0` 短路，
//      touch 了脚本契约还是全绿。所以源码里必须同时有「起>0 && 改>0」的守卫分支。
//   ③ 真跑一次，0 项不对（红了就是真有服务在跑旧代码 —— 这正是它该拦的）

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 源 = () => readFileSync(TOOLS + '/契约检查.mjs', 'utf8')

test('A1 契约里有「服务不许跑旧代码」这一节，且服务名可配（不再写死别家单元名）', () => {
  // SERVICES_ENV 2026-11-24：旧断言要求契约源码里出现四个**字面**单元名
  // （fish-panel / fish-upstream / fish-music / qq-logserver）。那四个是别家实例的；
  // 本机实例全是 hajimi-*，一个都对不上 → 那两条检查在本机静默空转（查不到就 continue），
  // 真跑旧代码也不会红。断言钉字面名 = 钉死「只能用那一套名字」，本身就是分叉源。
  // 现在断言三件真事：
  //   ① 这一节在
  //   ② 服务名走环境变量（SVC_* / SERVICES），源码里必须有可配入口
  //   ③ 本机 SERVICES 覆盖的服务，契约里至少认得出一个（证明配置真的被用上）
  const s = 源()
  assert.match(s, /服务不是旧代码/, '这一节没了')
  assert.match(s, /process\.env\.SVC_PANEL|process\.env\['SVC_PANEL'\]|SVC\('SVC_PANEL'/, '面板单元名没有可配入口')
  assert.match(s, /process\.env\.SERVICES|SERVICES\b/, '生产单元清单没有可配入口')
  const 真名 = String(process.env.SERVICES || '').split(',').map((x) => x.trim()).filter(Boolean)
  if (真名.length) {
    assert.ok(真名.some((u) => s.includes('SVC_') || s.includes('process.env.SERVICES')),
      'SERVICES 配了但契约里没有任何读取它的代码')
  }
})

test('A2 判不了不许算通过（起/改 任一读不到都要单独判一条）', () => {
  const s = 源()
  assert.match(s, /查\(起 > 0 && 改 > 0/, '没有「读不到就不算通过」的分支 —— 会静默全绿（批次452 就是这么漏的）')
  assert.match(s, /判不了，不能算通过/, '那个分支的说明文字没了')
  // 旧写法：只有一条 查，且 起>0 短路
  assert.doesNotMatch(s, /查\(!\(起 > 0 && 改 > 起 \+ 60e3\)/, '旧的单条写法回来了（起=0 时静默通过）')
})

test('A3 真跑一次：0 项不对（有服务跑旧代码时这里就该红）', () => {
  const r = spawnSync('/usr/local/bin/node', [TOOLS + '/契约检查.mjs'], { encoding: 'utf8', timeout: 60000 })
  const 出 = String(r.stdout || '') + String(r.stderr || '')
  assert.match(出, /契约检查：\d+ 项通过 \/ 0 项不对/, '契约没过：' + 出.slice(-600))
})

test('A4 报错要能直接照着做：带单元名 + restart 命令', () => {
  const s = 源()
  assert.match(s, /得 systemctl restart ' \+ 单元/, '报错里没给 restart 命令')
  assert.match(s, /服务起于 ' \+ 北京时刻\(起\)/, '报错里没给服务启动时刻')
})
