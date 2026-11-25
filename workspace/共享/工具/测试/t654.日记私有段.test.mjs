// t654 —— 审计 P0-2：qq_recall 翻日记时必须走 日记.mjs 的权限裁剪。
//
// 现象：回忆.mjs 原来自己 readFileSync 日记，再 replace(/~~/g,'') 把删除线去掉，
// 于是「~~这一句~~」变成普通句子、「## 只给你」整节照发。群聊里 qq_recall
// 一翻就能看到本应只给主人的内容。
//
// 现在的判据：日记的公开/私有边界只在 日记.mjs 给角色() 一处决定；
// 回忆.mjs 传 QQ_RECALL_ROLE，recall.js 用 recentDelivery() 判「是不是主人私聊」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

process.env.QUIET_NOTE = '1'

const TOOLS = process.env.QQ_TOOLS_DIR || '/data/hajimi-workspace/共享/工具'
const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

const 日记正文 = `# ${今天}

## 上午

去了趟便利店，买了咖啡，路上风挺大，回来的时候天已经亮透了。

~~这句是划掉的，只给主人看，里面有很私密的事情。~~

## 只给你

这一节整节都是私房话，客人一个字都不该看到。
`

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 't654-'))
  const mem = join(sb, 'mem')
  const diary = join(sb, 'diary')
  mkdirSync(mem, { recursive: true })
  mkdirSync(diary, { recursive: true })
  writeFileSync(join(diary, `${今天}.md`), 日记正文)
  return { sb, mem, diary, 清: () => rmSync(sb, { recursive: true, force: true }) }
}

function 跑回忆({ mem, diary }, role, args = ['--日', 今天, '--json']) {
  return execFileSync(process.execPath, [join(TOOLS, '回忆.mjs'), ...args], {
    encoding: 'utf8', timeout: 20000,
    env: {
      ...process.env,
      QQ_RECALL_MEM: mem,
      QQ_RECALL_DIARY: diary,
      QQ_RECALL_ROLE: role,
    },
  })
}

const 日记条目 = (out) => (JSON.parse(out).条目 || []).filter((x) => x.来源 === '日记')

test('D1 主人私聊：划掉的句子照常返回（按天只取前两段，私有节用词查）', () => {
  const 盒 = 造()
  try {
    // 按天：日记只取前两段（回忆.mjs 的既有上限），划掉那句是第二段
    const 按天 = 日记条目(跑回忆(盒, 'owner')).map((x) => x.文).join('\n')
    assert.match(按天, /划掉的/, '主人的私有段被吞了')
    // 「只给你」整节是第三段，按天取不到 —— 用词查验证它确实对主人可见
    const 按词 = 日记条目(跑回忆(盒, 'owner', ['--词', '私房话', '--json'])).map((x) => x.文).join('\n')
    assert.match(按词, /私房话/, '主人的「只给你」整节被吞了')
  } finally { 盒.清() }
})

test('D2 群聊/客人：划掉的句子和「只给你」整节都不出现', () => {
  const 盒 = 造()
  try {
    const 按天 = 日记条目(跑回忆(盒, 'guest')).map((x) => x.文).join('\n')
    assert.ok(!/划掉的/.test(按天), '群聊里翻到了划掉的私有句：' + 按天)
    assert.match(按天, /便利店/, '公开段落也没了，裁剪裁过头')
    // 词查会扫全部段落，正好覆盖第三段那个私有节
    const 按词 = 日记条目(跑回忆(盒, 'guest', ['--词', '私房话', '--json'])).map((x) => x.文).join('\n')
    assert.ok(!/私房话/.test(按词), '群聊里翻到了「只给你」整节：' + 按词)
  } finally { 盒.清() }
})

test('D3 没传角色时默认按客人处理（少给，不会多给）', () => {
  const 盒 = 造()
  try {
    const out = execFileSync(process.execPath, [join(TOOLS, '回忆.mjs'), '--日', 今天, '--json'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, QQ_RECALL_MEM: 盒.mem, QQ_RECALL_DIARY: 盒.diary, QQ_RECALL_ROLE: '' },
    })
    const 全 = 日记条目(out).map((x) => x.文).join('\n')
    assert.ok(!/私房话/.test(全), '缺省角色拿到了私有段')
  } finally { 盒.清() }
})

test('D4 recall.js 的角色判定：只有「私聊主人」才是 owner', async () => {
  const { recallRoleOf } = await import(pathToFileURL(join(LIB, 'recall.js')).href + '?t654=1')
  const cfg = { ownerUin: '3439411062' }
  assert.equal(recallRoleOf({ kind: 'private', id: '3439411062' }, cfg), 'owner')
  assert.equal(recallRoleOf({ kind: 'group', id: '1051483012' }, cfg), 'guest')
  assert.equal(recallRoleOf({ kind: 'private', id: '999999' }, cfg), 'guest')
  assert.equal(recallRoleOf(null, cfg), 'guest')
  assert.equal(recallRoleOf({ kind: 'private', id: '3439411062' }, { ownerUin: '' }), 'guest')
})

// DESC_DIARY 2026-11-17（批次658，审计 P1-5）：621/624 把日记接进 qq_recall 了，
// 但工具描述一直写着「手账、梦和记忆链」—— 她按描述选工具，会以为翻不到日记。
test('D5 qq_recall 的工具描述里写明日记与私有段边界', async () => {
  const { readFileSync } = await import('node:fs')
  const s = readFileSync(join(LIB, 'recall.js'), 'utf8')
  assert.match(s, /description: '查记忆[^']*日记/, '描述里没有日记')
  assert.match(s, /日记私有段仅主人私聊可见/, '描述里没写私有段边界')
  assert.doesNotMatch(s, /description: '[^']*(?:rofm|hippocampus)/, '描述还指向已退役的 rofm/hippocampus')
})
