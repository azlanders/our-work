// t575 —— P0 对接四条：私聊文件目标 / 资产锁 / 物品锁 / 心跳重复任务
//
// 事故背景（2026-11-16 审计）：
//   · 私聊发文件写死 peerUin，给别的好友发会发到主人；
//   · 资产.json 有 14 处锁外整档写，结息/买东西/移动撞上会丢钱；
//   · 物品.mjs 被 花钱/快递/自主行动 并发 spawn，读改写没锁会丢件；
//   · 心跳表里“本子同步”和 crontab 重复，且没有日志，失败没人知道。
//
// 这条测试用真并发跑，不看注释、不看断言绿：8 个进程同时入库/花钱，最后数字必须对得上。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

// t453：这个文件会 import 插件 lib，note() 会写生产日志；测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

function 造盒() {
  const 根 = mkdtempSync(join(tmpdir(), 't575-'))
  const 记忆 = join(根, '记忆')
  mkdirSync(记忆, { recursive: true })
  writeFileSync(join(记忆, '资产.json'), JSON.stringify({
    钱: 100, 包: [], 家: [], 记录: [], 位置: '家',
  }))
  return {
    根,
    记忆,
    env: {
      ...process.env,
      QQ_AUTONOMY_MEM: 记忆,
      QQ_LOCK_DIR: join(记忆, '.locks'),
      NODE_OPTIONS: '',
    },
    清: () => rmSync(根, { recursive: true, force: true }),
  }
}

function 起(盒, 脚本, 参数) {
  return spawn(process.execPath, [join(工具, 脚本), ...参数], {
    env: 盒.env,
    stdio: 'ignore',
  })
}

function 等(子) {
  return new Promise((resolve, reject) => {
    子.on('error', reject)
    子.on('exit', (码) => (码 === 0 ? resolve() : reject(new Error('退出码 ' + 码))))
  })
}

test('C1 物品：8 个进程同时 --入，最后必须 8 份', async () => {
  const 盒 = 造盒()
  try {
    await Promise.all(Array.from({ length: 8 }, () =>
      等(起(盒, '物品.mjs', ['--入', '薯片', '--在', '包', '--类', '零食']))))
    const d = JSON.parse(readFileSync(join(盒.记忆, '物品.json'), 'utf8'))
    const 薯片 = (d.items || []).find((x) => x.n === '薯片')
    assert.equal(薯片?.数, 8, '并发入库丢件：期望 8 份，实际 ' + (薯片?.数 ?? 0))
  } finally { 盒.清() }
})

test('C2 资产：8 个进程同时各花 1 块，最后必须剩 92', async () => {
  const 盒 = 造盒()
  try {
    await Promise.all(Array.from({ length: 8 }, () =>
      等(起(盒, '资产.mjs', ['--花', '1', '--为什么', '并发测试']))))
    const a = JSON.parse(readFileSync(join(盒.记忆, '资产.json'), 'utf8'))
    assert.equal(a.钱, 92, '并发花钱丢更新：期望 92，实际 ' + a.钱)
    assert.equal((a.记录 || []).length, 8, '流水条数不对：期望 8，实际 ' + (a.记录 || []).length)
  } finally { 盒.清() }
})

test('C3 花钱买早饭：父进程持资产锁，物品子进程不能互锁', async () => {
  const 盒 = 造盒()
  try {
    const a = JSON.parse(readFileSync(join(盒.记忆, '资产.json'), 'utf8'))
    a.位置 = '便利店'
    writeFileSync(join(盒.记忆, '资产.json'), JSON.stringify(a))
    await 等(起(盒, '花钱.mjs', ['--买', '早饭']))
    const 后 = JSON.parse(readFileSync(join(盒.记忆, '资产.json'), 'utf8'))
    const 物品 = JSON.parse(readFileSync(join(盒.记忆, '物品.json'), 'utf8'))
    assert.equal(后.钱, 92, '买 8 块的早饭应剩 92，实际 ' + 后.钱)
    assert.ok((后.包 || []).includes('早饭'), '资产.包 没同步到早饭')
    assert.ok((物品.items || []).some((x) => x.n === '早饭'), '物品.json 没收到早饭')
  } finally { 盒.清() }
})

test('C4 私聊文件目标：上传分支必须用 target.id，不能写死 peerUin', () => {
  const 源 = readFileSync(join(插件, 'outbound.js'), 'utf8')
  const 块 = 源.slice(源.indexOf('// 文件：走 OneBot'), 源.indexOf('return result ?? imageResult'))
  assert.match(块, /upload_private_file[\s\S]*user_id:\s*Number\(target\.id\)/, '文件上传没用 target.id')
  assert.equal(/upload_private_file[\s\S]{0,80}config\.peerUin/.test(块), false, '文件上传又写死 peerUin 了')
})

test('C5 心跳表：本子同步只留心跳表一份，北京 04:50', () => {
  const j = JSON.parse(readFileSync(join(工具, '心跳表.json'), 'utf8'))
  const 条 = (j.任务 || []).filter((x) => x.名 === '本子同步' || x.脚本 === '本子同步.mjs')
  assert.equal(条.length, 1, '心跳表里本子同步应恰好一条')
  assert.equal(条[0].时, 4, '时是北京时刻')
  assert.equal(条[0].分, 50)
  assert.ok(Number(条[0].超时毫秒 || 0) >= 60000, '上传网盘要给足超时')
  assert.equal((j.任务 || []).length, 55, '任务数应为 55；加任务时同步改这条')
  const cron = execFileSync('crontab', ['-l'], { encoding: 'utf8' })
  assert.equal(/网盘本子-sync/.test(cron), false, 'crontab 里还留着重复的本子同步')
})

test('C13 P0-2 残留：洗澡/吃饭/作息 的资产写必须走改档', () => {
  for (const f of ['洗澡.mjs', '吃饭.mjs', '作息.mjs']) {
    const s = readFileSync(join(工具, f), 'utf8')
    assert.equal(/save\((AS|ap),\s*(资产|a)\)/.test(s), false, f + ' 还在锁外整档写资产')
    assert.ok(s.includes('改档(AS') || s.includes("改档(join(base, '资产.json')"), f + ' 没接改档')
  }
})

test('C14 缺配置不许全放开：DEFAULTS 的工具白名单不是空数组', () => {
  const s = readFileSync(join(插件, 'config.js'), 'utf8')
  assert.match(s, /工具白名单: \[\s*'qq_send'/, '工具白名单默认值又变回空数组（缺配置 = 全部下发）')
})

test('C15 物品总表是薄壳：CLI 转发 + export * 表.mjs', () => {
  const s = readFileSync(join(工具, '物品总表.mjs'), 'utf8')
  assert.match(s, /export \* from '\.\/表\.mjs'/, '旧入口没有导出，import 会拿不到 查/所有')
})

test('C6 短期记忆：deliver 必须真的调 mem-short，不能再是空字符串', () => {
  const 源 = readFileSync(join(插件, 'deliver.js'), 'utf8')
  assert.match(源, /mem-short/, 'deliver.js 里找不到 mem-short')
  assert.equal(/const out = ''/.test(源), false, '短期记忆又被硬编码成空了')
})

test('C7 qq_wait：目标参数和 newMessages 必须删掉，避免模型以为在等某人', () => {
  const 源 = readFileSync(join(插件, 'tool.js'), 'utf8')
  const 块 = 源.slice(源.indexOf("name: 'qq_wait'"), 源.indexOf('qq_wait registered'))
  assert.equal(/group_id/.test(块), false, 'qq_wait 还声明了 group_id')
  assert.equal(/user_id/.test(块), false, 'qq_wait 还声明了 user_id')
  assert.equal(/newMessages/.test(块), false, 'qq_wait 还返回 newMessages')
})

test('C8 耐心：--扣 5 必须从 60 扣到 55，并记下打断时间', () => {
  const 盒 = 造盒()
  try {
    writeFileSync(join(盒.记忆, '状态.json'), JSON.stringify({
      耐心: { 短期: 60, 长期: 70, 上次被打断: 0, 短期更新于: '2026-11-16 17:00', 长期更新于: '2026-11-16 17:00' },
    }))
    execFileSync(process.execPath, [join(工具, '耐心.mjs'), '--扣', '5'], {
      encoding: 'utf8', env: { ...盒.env, ST_BASE: 盒.记忆 },
    })
    const s = JSON.parse(readFileSync(join(盒.记忆, '状态.json'), 'utf8'))
    assert.equal(s['耐心']['短期'], 55)
    assert.ok(Number(s['耐心']['上次被打断']) > 0)
  } finally { 盒.清() }
})

test('C9 怨：奖惩权重 8 必须落成 100 分制的 8', () => {
  const 盒 = 造盒()
  try {
    execFileSync(process.execPath, [join(工具, '怨.mjs'), '--who', '123', '--level', '0.8', '--why', '坏话'], {
      encoding: 'utf8', env: { ...盒.env, QQ_YUAN_MEM: 盒.记忆 },
    })
    const y = JSON.parse(readFileSync(join(盒.记忆, '怨.json'), 'utf8'))
    assert.equal(y.people['123'].level, 8)
  } finally { 盒.清() }
})

test('C10 旧总表：物品总表.mjs 必须和 表.mjs 输出一致，且不再崩', () => {
  const 旧 = execFileSync(process.execPath, [join(工具, '物品总表.mjs')], { encoding: 'utf8' }).trim()
  const 新 = execFileSync(process.execPath, [join(工具, '表.mjs')], { encoding: 'utf8' }).trim()
  assert.equal(旧, 新)
  assert.match(旧, /样/)
})

test('C11 白名单：当前可用的 3 个 qq 工具必须在线上下发', () => {
  const 配置 = JSON.parse(readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
  const 名单 = 配置['工具白名单'] || []
  // 2026-11-17：`qq_emoji_search` / `qq_lie` 仍在注册表，但为压工具 schema，
  // 已从实际下发名单里裁掉；这里是“白名单里有什么”，不是“注册了什么”。
  for (const n of ['qq_unsend', 'qq_self', 'qq_qzone_post']) {
    assert.ok(名单.includes(n), '白名单漏了 ' + n)
  }
})

test('C12 奖惩：权重里的怨必须接到 怨.mjs', () => {
  const 源 = readFileSync(join(工具, '奖惩.mjs'), 'utf8')
  assert.match(源, /怨\.mjs/, '奖惩.mjs 没有调用 怨.mjs')
  assert.match(源, /K\[kind\]/, '奖惩.mjs 没有读权重表')
})
