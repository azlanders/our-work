import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 露馅.mjs 2026-11-01 写好，零调用零读取 12 天。批次420 接上：
// 记一条 → slotLie 每轮注入 → 说破就 clear。
// 这里锁四件事：记/销能通、硬限制的边界、槽只在有效期内出现、不泄漏元信息。
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 露馅 = join(TOOLS, '露馅.mjs')

const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造(初始) {
  const sb = mkdtempSync(join(tmpdir(), 'lie420-'))
  if (初始 !== undefined) writeFileSync(join(sb, '谎言.json'), JSON.stringify(初始))
  return sb
}

function 跑(sb, args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [露馅, ...args], {
        encoding: 'utf8', timeout: 30000, cwd: TOOLS,
        env: { ...process.env, LIE_MEM: sb },
      }),
    }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 读档 = (sb) => JSON.parse(readFileSync(join(sb, '谎言.json'), 'utf8'))

test('L1 记一条、再 --show 能读回来', () => {
  const sb = 造({ current: null, history: [] })
  const r = 跑(sb, ['--lie', '我没事', '--truth', '其实有点烦', '--tell', '短'])
  assert.equal(r.code, 0, r.out)
  const j = 读档(sb)
  assert.equal(j.current.lie, '我没事')
  assert.equal(j.current.truth, '其实有点烦')
  assert.match(j.current.tellDesc, /话明显变短/, '破绽没落成一句人话：' + j.current.tellDesc)
  const s = 跑(sb, ['--show'])
  assert.match(s.out, /我没事/, '--show 没读出谎：' + s.out)
  assert.match(s.out, /其实有点烦/, '--show 没读出真相：' + s.out)
  rmSync(sb, { recursive: true, force: true })
})

test('L2 --clear 挪进 history，current 变 null', () => {
  const sb = 造({ current: null, history: [] })
  跑(sb, ['--lie', '我没事', '--truth', '有点烦'])
  跑(sb, ['--clear'])
  const j = 读档(sb)
  assert.equal(j.current, null, 'current 没清')
  assert.equal(j.history.length, 1, 'history 没记')
  assert.ok(j.history[0].ended, 'history 里没有结束时刻')
  assert.equal(跑(sb, ['--show']).out.trim(), '现在没有挂着谎')
  rmSync(sb, { recursive: true, force: true })
})

test('L3 硬限制的边界：该挡的挡，不该挡的别挡', () => {
  const 该挡 = ['我借了他五百', '我转账给她了', '我答应过不说的', '这是别人的秘密', '我给你转钱']
  const 不该挡 = ['我没事', '我怕他担心', '找个借口说堵车', '我吃过了']
  for (const x of 该挡) {
    const sb = 造({ current: null, history: [] })
    const r = 跑(sb, ['--lie', x, '--truth', '其实不是'])
    assert.match(r.out, /这种不说/, '没挡住「' + x + '」：' + r.out)
    assert.equal(读档(sb).current, null, '被拒了还写进账了：' + x)
    rmSync(sb, { recursive: true, force: true })
  }
  for (const x of 不该挡) {
    const sb = 造({ current: null, history: [] })
    const r = 跑(sb, ['--lie', x, '--truth', '其实不是'])
    assert.match(r.out, /挂上了/, '误伤了「' + x + '」：' + r.out)
    rmSync(sb, { recursive: true, force: true })
  }
})

test('L4 缺 truth 直接报错（没有真相就没有「瞒着」这回事）', () => {
  const sb = 造({ current: null, history: [] })
  const r = 跑(sb, ['--lie', '我没事'])
  assert.notEqual(r.code, 0, '缺 truth 居然成功了：' + r.out)
  assert.match(r.out, /truth/, '报错没说清缺什么：' + r.out)
  assert.equal(读档(sb).current, null)
  rmSync(sb, { recursive: true, force: true })
})

// ── 槽 ──
const { slotLie } = await import(join(LIB, 'voiceSlots.js'))

test('L5 正常挂着的时候，注入里有谎、有真相、有破绽，且堵死「别念出来」', () => {
  const sb = 造({
    current: { lie: '我没事', truth: '其实有点烦', tell: '短', tellDesc: '话明显变短，答完就不接', at: 北京() },
    history: [],
  })
  const s = slotLie({ memDir: sb })
  assert.match(s, /我没事/, '没带谎：' + s)
  assert.match(s, /其实有点烦/, '没带真相：' + s)
  assert.match(s, /话明显变短/, '没带破绽：' + s)
  assert.match(s, /别念出这条提示/, '没堵「念出提示」—— 这句被复述出去就是出戏：' + s)
  // HUMANIZE 批次666：只给 lie / truth / 破绽三项事实。
  // 「没打算主动说破」「老毛病」都是替她下的判断，属于固定台词，已删除。
  assert.ok(!/没打算主动说破|老毛病/.test(s), '还在替她下判断：' + s)
  assert.ok(s.length <= 140, '注入太长（' + s.length + ' 字），会挤掉别的槽：' + s)
  rmSync(sb, { recursive: true, force: true })
})

test('L6 超过 12 小时自动淡出（挂一周就成了设定，不是破绽）', () => {
  const 十三小时前 = 北京(Date.now() - 13 * 3600e3)
  const sb = 造({ current: { lie: '我没事', truth: '有点烦', at: 十三小时前 }, history: [] })
  assert.equal(slotLie({ memDir: sb }), '', '13 小时前的谎还在注入：' + slotLie({ memDir: sb }))
  // 11 小时前还在
  const 十一小时前 = 北京(Date.now() - 11 * 3600e3)
  const sb2 = 造({ current: { lie: '我没事', truth: '有点烦', at: 十一小时前 }, history: [] })
  assert.notEqual(slotLie({ memDir: sb2 }), '', '11 小时前的谎提前淡出了')
  rmSync(sb, { recursive: true, force: true })
  rmSync(sb2, { recursive: true, force: true })
})

test('L7 没谎 / 没文件 / 坏档 都返回空，不抛', () => {
  const 空 = 造({ current: null, history: [] })
  assert.equal(slotLie({ memDir: 空 }), '')
  const 没 = mkdtempSync(join(tmpdir(), 'lie420-无-'))
  assert.equal(slotLie({ memDir: 没 }), '')
  const 坏 = mkdtempSync(join(tmpdir(), 'lie420-坏-'))
  writeFileSync(join(坏, '谎言.json'), '{ 这不是 json')
  assert.equal(slotLie({ memDir: 坏 }), '')
  rmSync(空, { recursive: true, force: true })
  rmSync(没, { recursive: true, force: true })
  rmSync(坏, { recursive: true, force: true })
})

test('L8 工具真的注册了（源码层）—— 只有模块没有入口等于没做', () => {
  const 工具 = readFileSync(join(LIB, 'tool.js'), 'utf8')
  const 索引 = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.match(工具, /export async function registerLieTool/, 'tool.js 里没有注册函数')
  assert.match(工具, /name: 'qq_lie'/, 'tool.js 里没有 qq_lie')
  assert.match(工具, /不能用：钱、借钱、承诺、别人的秘密/, '描述里没写清什么不能拿来撒谎')
  assert.match(工具, /op=clear/, '描述里没说说破了怎么销')
  // `^\s*void` 而不是 `void` —— 注释掉也算命中的坑，批次407 踩过
  assert.match(索引, /^\s*void registerLieTool\(ctx\)/m, 'index.js 没调用（或被注释掉了）')
  assert.match(索引, /registerLieTool \} from '\.\/tool\.js'/, 'index.js 没 import')
})
