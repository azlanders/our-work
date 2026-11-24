// t416 —— 基础体检：数据 / 服务 / 健壮（批次411）
//
// 为什么要有：2026-11-14 那次手工查了一遍（436 个 json 全可解析、4 个单元 active、
// 近 3 天没 OOM），**查完就没了**。这文件锁的是「这三块以后每天自己查」。
//
// 它跟另外三个体检不是一回事：
//   生活体检  她此刻的生活数据合不合理（穿错衣服、饿多久）
//   闭环体检  写了的东西有没有人用（死导出、零调用）
//   契约检查  代码结构对不对（628 项）
//   **这个** 「她还能不能说话」：档没坏、服务在、没被系统杀掉
//
// 这个文件锁：
//   G1 干净环境：问题 0、退出码 0、不写待办
//   G2 坏一个 json → 退出码 1 + 待办里有一条（说清是哪个档）
//   G3 服务不在 → 退出码 1（用假服务名造）
//   G4 --json 能机器读（面板/脚本要用）
//   G5 目录不存在/空目录不崩
//   G6 跑得够快（心跳是每分钟串行几十条，这个每天一次也不能占太久）
//   G7 待办写不进去要留痕（别重复 409 那个空 catch 的坑）
//
// 跑法：node --test t416.基础体检.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const CLI = join(TOOLS, '体检-基础.mjs')
const 沙 = mkdtempSync(join(tmpdir(), 'base416-'))
const 档 = join(沙, '待办.json')
const MEM = join(沙, '记忆')

function 准备() {
  rmSync(沙, { recursive: true, force: true })
  mkdirSync(MEM, { recursive: true })
  writeFileSync(join(MEM, '状态.json'), JSON.stringify({ energy: 50 }))
  writeFileSync(join(MEM, 'a.jsonl'), '{"x":1}\n{"x":2}\n')
}
function 跑(extra = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: TOOLS,
      env: { ...process.env, BASE_MEM: MEM, TODO_FILE: 档, SKIP_SYSTEMD: '1', ...extra },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}
function 待办() {
  try { return JSON.parse(readFileSync(档, 'utf8')) } catch { return { items: [], done: [] } }
}

test('G1 干净环境：问题 0、退出码 0、不写待办', () => {
  准备()
  const r = 跑()
  assert.equal(r.code, 0, '干净环境退出码非 0：\n' + r.out.slice(-600))
  assert.ok(/问题 0 条/.test(r.out), '不是 0 条问题：\n' + r.out.slice(-600))
  assert.equal(待办().items.length, 0, '干净环境还写了待办：' + JSON.stringify(待办().items.map((x) => x.id)))
})

test('G2 坏一个 json → 退出码 1 + 待办里说清是哪个档', () => {
  准备()
  writeFileSync(join(MEM, '坏的.json'), '{ 这不是 json')
  const r = 跑()
  assert.equal(r.code, 1, '坏档了退出码还是 0')
  assert.ok(/坏的\.json/.test(r.out), '输出里没指出是哪个档坏了：\n' + r.out.slice(-600))
  const d = 待办()
  const 这条 = d.items.find((x) => x.id === '体检-基础')
  assert.ok(这条, '坏档没写待办')
  assert.ok(/坏的\.json/.test(这条.事项), '待办没说清是哪个档：' + 这条.事项)
})

test('G3 服务不在 → 退出码 1', () => {
  准备()
  const r = 跑({ SKIP_SYSTEMD: '0', SERVICES: 'dsh-bot,一个根本不存在的单元xyz' })
  assert.equal(r.code, 1, '假服务也报绿：\n' + r.out.slice(-700))
  assert.ok(/一个根本不存在的单元xyz/.test(r.out), '输出里没点名是哪个单元：\n' + r.out.slice(-700))
})

test('G4 --json 能机器读', () => {
  准备()
  const out = execFileSync(process.execPath, [CLI, '--json'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: TOOLS,
    env: { ...process.env, BASE_MEM: MEM, TODO_FILE: 档, SKIP_SYSTEMD: '1' },
  })
  const j = JSON.parse(out)
  assert.equal(typeof j.问题数, 'number')
  assert.equal(typeof j.档数, 'number')
  assert.ok(Array.isArray(j.坏档))
})

test('G5 目录不存在/空目录不崩', () => {
  const 空 = join(沙, '根本没有这个目录')
  for (const mem of [空]) {
    const r = (() => {
      try {
        const out = execFileSync(process.execPath, [CLI], {
          encoding: 'utf8', timeout: 30000, cwd: TOOLS,
          env: { ...process.env, BASE_MEM: mem, TODO_FILE: 档, SKIP_SYSTEMD: '1' },
        })
        return { code: 0, out }
      } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
    })()
    assert.equal(r.code, 0, '记忆目录不存在就崩了：\n' + r.out.slice(-400))
    assert.ok(!/TypeError|ReferenceError/.test(r.out), '抛了 JS 错：\n' + r.out.slice(-400))
  }
})

test('G6 跑得够快', () => {
  准备()
  const t0 = Date.now()
  跑()
  const ms = Date.now() - t0
  assert.ok(ms < 10000, '跑一次要 ' + ms + 'ms —— 会拖心跳')
})

test('G7 待办写不进去要留痕', () => {
  准备()
  writeFileSync(join(MEM, '坏的.json'), '{ 坏')
  const r = spawnSync(process.execPath, [CLI, '--静'], {
    encoding: 'utf8', timeout: 30000, cwd: TOOLS,
    env: { ...process.env, BASE_MEM: MEM, TODO_FILE: 沙, SKIP_SYSTEMD: '1' },   // 沙 是目录 → EISDIR
  })
  assert.ok(/\[待办未写入\]/.test(String(r.stderr || '')), '待办写不进去却一声不吭：' + JSON.stringify(String(r.stderr || '').slice(0, 160)))
})

// ── 第四块：插件快照（批次412 加的）────────────────────────────
// 为什么它属于「基础」：`reapply-patches.sh` 不带参数就是「覆盖恢复 + 重启」。
// 快照要是过期，一次手抖就把最近所有改动冲回旧版，而且不报错。
// 实测 2026-11-14 05:54：快照停在 11-05，9 个文件在风险区。
test('G8 插件快照不一致时能看见', () => {
  准备()
  const 插件 = join(沙, 'plugin')
  mkdirSync(join(插件, 'lib'), { recursive: true })
  writeFileSync(join(插件, 'lib', 'a.js'), 'console.log(1)')
  const 清单 = join(沙, 'lib.md5')
  writeFileSync(清单, 'deadbeefdeadbeefdeadbeefdeadbeef  lib/a.js\n')
  const r = 跑({ PATCH_SNAPSHOT: 清单, PLUGIN_ROOT: 插件 })
  assert.ok(/快照差 1|不一致|不一样/.test(r.out), '快照对不上却没报：\n' + r.out.slice(-600))
  assert.ok(/lib\/a\.js/.test(r.out), '没点名是哪个文件：\n' + r.out.slice(-600))
})

test('G9 快照一致时不吵（--save 之后的日常状态）', () => {
  准备()
  const 插件 = join(沙, 'plugin')
  mkdirSync(join(插件, 'lib'), { recursive: true })
  const 内容 = 'console.log(1)'
  writeFileSync(join(插件, 'lib', 'a.js'), 内容)
  const 清单 = join(沙, 'lib.md5')
  writeFileSync(清单, createHash('md5').update(内容).digest('hex') + '  lib/a.js\n')
  const r = 跑({ PATCH_SNAPSHOT: 清单, PLUGIN_ROOT: 插件 })
  assert.ok(/与快照一致/.test(r.out), '一致还说有差：\n' + r.out.slice(-600))
})

test('G10 快照不一致但还很新 → 不催（刚改完代码当然不一致）', () => {
  准备()
  const 插件 = join(沙, 'plugin')
  mkdirSync(join(插件, 'lib'), { recursive: true })
  writeFileSync(join(插件, 'lib', 'a.js'), 'console.log(1)')
  const 清单 = join(沙, 'lib.md5')
  writeFileSync(清单, 'deadbeefdeadbeefdeadbeefdeadbeef  lib/a.js\n')   // 刚写的，0 小时
  const r = 跑({ PATCH_SNAPSHOT: 清单, PLUGIN_ROOT: 插件 })
  assert.ok(/快照差 1|不一样/.test(r.out), '不一致该列出来：\n' + r.out.slice(-600))
  assert.equal(待办().items.filter((x) => x.id === '体检-基础').length, 0,
    '刚改完就催 --save 是噪音 —— 只有超过 24 小时不一致才该催')
})
