// t414 —— 三个每周体检：从「写日志没人看」变成「有问题上面板」（批次409）
//
// 病根：
//   闭环体检 / 契约检查 / 判断权体检 都是每周跑的，结果只写进各自的 .log。
//   而那两个 .log 的最后一条都停在 **2026-11-09**（上一次周一）——
//   也就是说「跑了、写进日志了、没人翻」。日志是给已经会去看的人写的。
//   更糟的是 `体检-闭环.mjs --静` 连摘要都只打一行，`契约检查` 红了也只 `console.log`。
//
// 修法（照 会话体检.mjs 的现成范式）：
//   有问题 → 待办.同步({ id, 事项, 来源, 该在: true }) → 面板「需要你处理」里挂一条
//   问题没了 → 该在: false → 自动挪进 done，谁=自动
//   id 是稳定的（一次检查只维护一条），按文字去重会攒成一排。
//
// 这个文件锁：
//   F1 三个脚本都真的接上了待办（import + 同步 + 该在条件）—— 两边都跑
//   F2 干净的时候跑一遍不新增待办（只对一号机：二号机静音、缺文件，本来就不干净）
//   F3 挂着的那条，问题消失后自动挪进 done（谁=自动）—— 用「判断权体检」，两边都绿
//   F5 真有问题时挂上待办（假 crontab 造「双轨」，脚本名从表里取，两边都成立）
//   F4 一号机的体检自己是绿的（只对一号机）
//
// 跑法：node --test t414.体检待办.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 读 = (p) => readFileSync(p, 'utf8')
// 别用 startsWith('{{BOT_ROOT}}') 判 —— 同步脚本会把那个前缀整体替换成
// {{BOT_ROOT}}，连这个判断里的一起换掉，于是二号机也算成了「一号机」。
const 是肥鱼 = !TOOLS.includes('hajimi')
const 二号机理由 = '二号机（{{BOT_DISPLAY}}）静音中：缺 photoWatch.js、契约未必全绿，本来就不是干净环境'
const 沙 = join(tmpdir(), 'todo414-' + process.pid)
const 档 = join(沙, '待办.json')

function 准备() {
  rmSync(沙, { recursive: true, force: true })
  mkdirSync(沙, { recursive: true })
}
function 跑(脚本, 参数 = [], extraEnv = {}) {
  return execFileSync(process.execPath, [join(TOOLS, 脚本), ...参数], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: TOOLS,
    env: { ...process.env, TODO_FILE: 档, ...extraEnv },
  })
}
function 待办() {
  if (!existsSync(档)) return { items: [], done: [] }
  return JSON.parse(读(档))
}

test('F1 三个脚本都真的接上了待办', () => {
  const 情形 = [
    ['体检-闭环.mjs', '体检-闭环'],
    ['契约检查.mjs', '契约检查'],
    ['体检-判断权.mjs', '判断权体检'],
  ]
  for (const [脚本, id] of 情形) {
    const 源 = 读(join(TOOLS, 脚本))
    assert.ok(/import \* as 待办 from '\.\/待办\.mjs'/.test(源), 脚本 + ' 没 import 待办')
    assert.ok(/待办\.同步\(\{/.test(源), 脚本 + ' 没调 待办.同步')
    assert.ok(源.includes("id: '" + id + "'"), 脚本 + ' 的待办 id 不是 ' + id)
    assert.ok(/该在:/.test(源), 脚本 + ' 没给「该在」条件 —— 问题修好了也不会自己消失')
  }
})

test('F2 干净的时候跑一遍不新增待办', { skip: !是肥鱼 && 二号机理由 }, () => {
  准备()
  跑('契约检查.mjs')
  跑('体检-判断权.mjs', ['--strict'])
  跑('体检-闭环.mjs', ['--静'])
  const d = 待办()
  assert.equal(d.items.length, 0, '干净仓库上还是写了待办：' + JSON.stringify(d.items.map((x) => x.id)))
})

test('F3 挂着的那条，问题没了会自动挪进 done', () => {
  准备()
  // 预置一条同 id 的（模拟「上次检查发现问题，挂上去了」）。
  // 用「判断权体检」而不是「契约检查」：前者两边都绿，后者在二号机不一定。
  writeFileSync(档, JSON.stringify({
    说明: '需要主人处理的事。面板只列这里，健康状态不占地方。',
    items: [{ id: '判断权体检', 事项: '判断权体检硬性违规 3 条：假的', 加于: '2026-11-13', 来源: '判断权体检' }],
    done: [],
  }, null, 2))
  assert.equal(待办().items.length, 1, '预置没写进去')

  跑('体检-判断权.mjs', ['--strict'])   // 现在是绿的
  const d = 待办()
  assert.equal(d.items.length, 0, '问题没了但待办还挂着')
  assert.equal(d.done.length, 1, '没挪进 done')
  assert.equal(d.done[0].id, '判断权体检')
  assert.equal(d.done[0].谁, '自动', '不是「自动」清的 —— 会跟主人手动标掉的混在一起')
})

test('F5 真有问题时挂上待办（用一个假 crontab 造「双轨」）', () => {
  // 不改任何文件就能造出一个确定的问题：crontab 里放一条心跳表里也有的脚本 = 两边都会跑。
  // CRONTAB_CMD 是 体检-闭环.mjs 自己留的口子（execSync 的替换）。
  // 脚本名从表里现取 —— 一号机和二号机的任务集不一样，写死「手账」只在一边成立。
  准备()
  const 表 = JSON.parse(读(join(TOOLS, '心跳表.json')))
  const 任务表 = Array.isArray(表) ? 表 : 表.任务
  const 一个脚本 = 任务表.map((t) => String(t.脚本 || '')).find((x) => x.endsWith('.mjs') && !x.includes('心跳'))
  assert.ok(一个脚本, '心跳表里一个 .mjs 都没有？')

  // EXIT_ALIGN 2026-11-14（批次429）：退出码改成跟「该管的」对齐之后，这条场景（双轨 = 真有问题）
  // 会返回 1。execFileSync 遇非 0 直接抛，所以要接住 —— 而且退出码本身现在也是断言的一部分：
  // 「造出了问题，$? 必须非 0」正是这个体检该有的行为（原来恒 0，拿 $? 判的人什么都看不到）。
  let 码 = 0
  let 输出 = ''
  try {
    输出 = String(execFileSync(process.execPath, [join(TOOLS, '体检-闭环.mjs'), '--静'], {
      encoding: 'utf8',
      timeout: 60000,
      cwd: TOOLS,
      env: { ...process.env, TODO_FILE: 档, CRONTAB_CMD: 'echo "0 5 * * * cd /tmp && node ' + 一个脚本 + '"' },
    }))
  } catch (e) {
    码 = e.status
    输出 = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  assert.equal(码, 1, '造出了双轨（真有问题），退出码该是 1，实际 ' + 码 + '\n' + 输出.slice(0, 300))
  const d = 待办()
  const 这条 = d.items.find((x) => x.id === '体检-闭环')
  assert.ok(这条, '造出了双轨却没挂待办：' + JSON.stringify(d.items.map((x) => x.id)))
  assert.equal(这条.来源, '闭环体检')
  assert.ok(/两边都有/.test(这条.事项), '待办里没写清是什么问题：' + 这条.事项)
  assert.ok(这条.事项.includes(一个脚本), '待办里没说是哪个脚本：' + 这条.事项)
})

test('F6 待办写不进去时要留痕（空 catch 会把它吞掉）', () => {
  // 这批最阴的一条：二号机的 待办.mjs 还是批次385 之前的版本，没有 同步 这个导出 ——
  // `待办.同步(...)` → TypeError → 被原来的空 catch 吞掉 → 体检照跑、待办静默不写、谁都不知道。
  // 造一个必然写不进去的路径，断言 stderr 里有痕迹。
  const 表 = JSON.parse(读(join(TOOLS, '心跳表.json')))
  const 任务表 = Array.isArray(表) ? 表 : 表.任务
  const 一个脚本 = 任务表.map((t) => String(t.脚本 || '')).find((x) => x.endsWith('.mjs') && !x.includes('心跳'))
  const r = spawnSync(process.execPath, [join(TOOLS, '体检-闭环.mjs'), '--静'], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: TOOLS,
    env: {
      ...process.env,
      // 指到一个「已经存在的目录」上 —— 写文件会立刻 EISDIR。
      // 别用 /proc/不存在的目录：file:///proc 上写临时文件会卡住（实测 15 秒不返回），测试会挂。
      TODO_FILE: 沙,
      CRONTAB_CMD: 'echo "0 5 * * * cd /tmp && node ' + 一个脚本 + '"',
    },
  })
  assert.ok(/\[待办未写入\]/.test(String(r.stderr || '')), '待办写不进去却一声不吭 —— 空 catch 又回来了：' + JSON.stringify(String(r.stderr || '').slice(0, 200)))
})

test('F4 一号机的体检自己是绿的（死导出 0、契约全过）', { skip: !是肥鱼 && 二号机理由 }, () => {
  准备()
  const out = 跑('体检-闭环.mjs', ['--静'])
  assert.ok(/死导出 0/.test(out), '又长回死导出了：' + out.trim())
  assert.ok(/缺脚本 0/.test(out), '心跳表里有脚本缺了：' + out.trim())
  assert.ok(/双轨 0/.test(out), 'crontab 和心跳表两边都在跑：' + out.trim())

  const 契 = 跑('契约检查.mjs')
  assert.ok(/0 项不对/.test(契), '契约检查有红：' + 契.split('\n').slice(-6).join('\n'))
})

test('E1 退出码与「该管的」一致，不是只看缺脚本', async () => {
  const { readFileSync } = await import('node:fs')
  // 面板待办认三件事（死导出 / 缺脚本 / 双轨），退出码原来只认缺脚本 —— 同一个体检两套口径，
  // 拿 $? 判的人永远看不到死导出和双轨。
  const 源 = readFileSync('{{BOT_ROOT}}/共享/工具/体检-闭环.mjs', 'utf8')
  assert.match(源, /process\.exit\(该管的\.length > 0 \? 1 : 0\)/, '退出码又只看缺脚本了')
  assert.doesNotMatch(源, /process\.exit\(缺脚本\.length > 0 \? 1 : 0\)/, '旧写法还在')
})
