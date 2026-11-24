// 自检.mjs —— 底座（_底层 / 睡态）的回归测试。
//
// 为什么要有它：`_底层` 被 27 个模块 import、`睡态` 被 16 个，是全项目扇入最高的两个。
// 它们错一个字，整个 cron 全线起不来。而之前的测试只活在 90-存档 的批次目录里 ——
// 跑一次就过去了，下次改没人再跑。放在这里，契约检查每周会带上它。
//
// 用法：
//   node 自检.mjs            打印 N 通过 / M 不对；有不对时 exit 1
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process' // POSITIVE_PATH 2026-11-12：正路径检查要起子进程
import { 读档, 写档, 北京, 北京秒, 北京日期, 解析北京 } from './_底层.mjs'
import { 睡着, 打盹中, 判据 } from './睡态.mjs'
import { 改 as 改自主, 起 as 起自主, 真位 } from './自主状态.mjs'
import { 档, 倍率, 是歇着, 说法 } from './在干嘛.mjs'
import { 精力 } from './恢复目标.mjs'
import { 一笔, 汇总, 某天 } from './账本.mjs'
import { 算在岗, 在岗的班 } from './占用.mjs'
import { saveState, loadState, clone } from './_状态.mjs'
import { 判定 } from './工作.mjs'

// ENTRY_GUARD 2026-11-14（批次458）：这个脚本顶层就是整条主流程，末尾还有 process.exit。
// 被 import 时（冒烟测试逐个 import）它会**真跑一遍**：实测冒烟跑一次 = 顺带跑两遍契约检查
// + 两遍自检，光这两项就往真档写了 538 次；而且 import 到一半 process.exit 直接把冒烟子进程
// 带走，冒烟那边只能记成「主动退出」，等于「加载测试」从来没真测过它。
// 现在只有 `node <本文件>` 这条路径才执行主流程；被 import 时只是一个空模块。
const 是入口 = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {


const 路径根 = fileURLToPath(new URL('.', import.meta.url))

const 好 = []
const 坏 = []
function 查(条件, 名, 细节) {
  if (条件) { 好.push(名); return }
  // 失败立刻打印，不等最后汇总 —— 否则后面某条行为测试一崩，前面的失败项就被冲掉了
  const 话 = 细节 ? `${名}（${细节}）` : 名
  坏.push(话)
  console.log('  ✗ ' + 话)
}

// ── 解析北京：项目里真实出现过的格式 + 坏输入 ────────────────────────
const 定点 = Date.parse('2026-11-07T06:02:23+08:00')
查(解析北京('2026-11-07 06:02:23') === 定点, '解析·空格带秒')
查(解析北京('2026-11-07 06:02') === 定点 - 23000, '解析·空格到分')
查(解析北京('2026-11-07T06:02:23+08:00') === 定点, '解析·已带时区')
查(解析北京('2026-11-07') === Date.parse('2026-11-07T00:00:00+08:00'), '解析·纯日期')
查(解析北京('2026-11-07 06:02:23.123') === 定点 + 123, '解析·带毫秒')
for (const 坏值 of ['', '   ', null, undefined, 0, '不是时间']) {
  查(解析北京(坏值, 0) === 0, `解析·坏输入 ${JSON.stringify(坏值)} 兜底 0`)
}
查(Number.isNaN(解析北京('不是时间', NaN)), '解析·兜底可传 NaN')

// ── 格式化三个 ────────────────────────────────────────────────────────
查(北京(定点) === '2026-11-07 06:02', '北京()', 北京(定点))
查(北京秒(定点) === '2026-11-07 06:02:23', '北京秒()', 北京秒(定点))
查(北京日期(定点) === '2026-11-07', '北京日期()', 北京日期(定点))

// ── 写档的实现约束（行为测不出来的那部分）────────────────────────────
// 单线程顺序写测不出「原子」——裸写也能每次都读回完整。
// 这三条是负测试逼出来的：把写档改回 writeFileSync(p) 时，上面 20 次连写仍然全绿。
// 并发性质没法在自检里跑（要起 4 个进程读 8 秒），就用源码结构锁住实现。
{
  const 源 = readFileSync(fileURLToPath(new URL('./_底层.mjs', import.meta.url)), 'utf8')
  const 起 = 源.indexOf('export function 写档')
  const 段 = 源.slice(起, 源.indexOf('export const 北京', 起))
  查(段.length > 0, '写档·源码里找得到')
  查(/renameSync\(\s*临时\s*,\s*p\s*\)/.test(段), '写档·必须是 tmp+rename，不是裸写', '有人把原子写改回去了')
  查(/'\.tmp-'\s*\+\s*process\.pid/.test(段), '写档·临时名必须带 pid', '固定 .tmp 两个进程会互相覆盖')
  查(/Math\.random\(\)/.test(段), '写档·临时名必须带随机', '同 pid 内重入会撞')
}

// ── 读档 / 写档 ───────────────────────────────────────────────────────
{
  const 根 = mkdtempSync(join(tmpdir(), 'ziji-'))
  try {
    const p = join(根, '子目录', 'a.json')          // 子目录不存在：写档要自己建
    查(读档(p, { 默认: true }).默认 === true, '读档·文件不在回落默认')
    查(写档(p, { a: 1, b: '中文' }) === true, '写档·返回 true')
    查(读档(p, {}).b === '中文', '写档·写进去能读回来')

    writeFileSync(join(根, '坏.json'), '{ 这不是 json')
    查(读档(join(根, '坏.json'), { 默认: 1 }).默认 === 1, '读档·坏 JSON 回落默认')

    writeFileSync(join(根, '空.json'), 'null')
    查(读档(join(根, '空.json'), { 默认: 2 }).默认 === 2, '读档·内容是 null 回落默认')

    writeFileSync(join(根, '标量.json'), '42')
    查(读档(join(根, '标量.json'), { 默认: 3 }).默认 === 3, '读档·内容是标量回落默认')

    const 干 = join(根, '干跑.json')
    查(写档(干, { x: 1 }, { 不写: true }) === false, '写档·不写 返回 false')
    查(读档(干, null) === null, '写档·不写 真的没落盘')

    写档(p, { c: 2 })
    const 残留 = readdirSync(join(根, '子目录')).filter((f) => f.includes('.tmp'))
    查(残留.length === 0, '写档·不留临时文件', 残留.join(','))

    let 都完整 = true
    for (let i = 0; i < 20; i++) {
      写档(p, { 填充: 'x'.repeat(5000), i })
      const v = 读档(p, null)
      if (!v || v.i !== i || v.填充.length !== 5000) { 都完整 = false; break }
    }
    查(都完整, '写档·连写 20 次每次读回来都完整')
  } finally { rmSync(根, { recursive: true, force: true }) }
}

// ── 睡态：七种文件组合 ────────────────────────────────────────────────
{
  const 根 = mkdtempSync(join(tmpdir(), 'shuitai-'))
  try {
    const 建 = (名, 醒档, 眠档, 盹档) => {
      const d = join(根, 名)
      mkdirSync(d, { recursive: true })
      if (醒档) writeFileSync(join(d, '睡醒.json'), JSON.stringify(醒档))
      if (眠档) writeFileSync(join(d, '睡眠.json'), JSON.stringify(眠档))
      if (盹档) writeFileSync(join(d, '打盹.json'), JSON.stringify(盹档))
      return d
    }
    const 未来 = Date.now() + 20 * 60e3
    const 场景 = [
      ['两套都亮', { sleeping: true, since: 'x' }, { sleeping: true, live: { start: 'x' } }, null, true],
      ['两套都灭', { sleeping: false, since: 'x' }, { sleeping: false, live: null }, null, false],
      ['标记挂着段已关', { sleeping: true, since: 'x' }, { sleeping: false, live: null }, null, true],
      ['段还开着标记说醒', { sleeping: false, since: 'x' }, { sleeping: true, live: { start: 'x' } }, null, false],
      ['标记被删段还开着', null, { sleeping: true, live: { start: 'x' } }, null, true],
      ['两个文件都不在', null, null, null, false],
      ['打盹中', { sleeping: false, since: 'x' }, { sleeping: false, live: null }, { 到毫秒: 未来 }, false],
    ]
    for (const [名, 醒档, 眠档, 盹档, 期望] of 场景) {
      const d = 建(名, 醒档, 眠档, 盹档)
      查(睡着(d) === 期望, `睡着·${名}`, `期望 ${期望} 实际 ${睡着(d)}`)
    }
    查(打盹中(建('盹未来', { sleeping: false }, null, { 到毫秒: 未来 })) === true, '打盹中·未来')
    查(打盹中(建('盹已过', { sleeping: false }, null, { 到毫秒: Date.now() - 1000 })) === false, '打盹中·已过')
    查(打盹中(建('盹没有', { sleeping: false }, null, null)) === false, '打盹中·文件不在')

    const 判 = 判据(建('判据', { sleeping: true, since: '2026-11-07 06:02' }, { live: { start: '2026-11-07 06:02:23' } }, null))
    查(判.睡着 === true && 判.睡醒标记 === true && 判.睡眠段 === true && 判.标记文件在 === true,
      '判据·字段齐全', JSON.stringify(判))
    查(判.段起点 === '2026-11-07 06:02:23' && 判.标记起点 === '2026-11-07 06:02', '判据·起点原样带出')
  } finally { rmSync(根, { recursive: true, force: true }) }
}

// ── 自主状态：起() 只写传进来的字段 ────────────────────────────────────
// 批次169：九个写 自主.json 的入口收成一个。这里的每一条都对应一次真实踩坑。
{
  const 根 = mkdtempSync(join(tmpdir(), '自检-自主-'))
  try {
    writeFileSync(join(根, '资产.json'), JSON.stringify({ 位置: '超市' }))
    起自主(根, { state: '吃饭', place: '便利店', doneAt: 111 })
    const 一 = 读档(join(根, '自主.json'), {})
    查(一.state === '吃饭' && 一.place === '便利店' && 一.doneAt === 111, '起·三件套', JSON.stringify(一))
    查(一.log === undefined, '起·默认不记 log')

    起自主(根, { note: '只改 note' })
    const 二 = 读档(join(根, '自主.json'), {})
    查(二.state === '吃饭' && 二.doneAt === 111 && 二.place === '便利店',
      '起·没传的字段一律不动', JSON.stringify(二))

    起自主(根, { state: '打瞌睡', 记: true, nextMinutes: 20 })
    const 三 = 读档(join(根, '自主.json'), {})
    查((三.log || []).length === 1 && 三.log[0].nextMinutes === 20 && 三.log[0].state === '打瞌睡',
      '起·记:true 才追 log', JSON.stringify(三.log))

    起自主(根, { state: '打工', 记: true, logNote: '面板点的' })
    const 四 = 读档(join(根, '自主.json'), {})
    查(四.log.at(-1).note === '面板点的' && 四.note === '只改 note',
      '起·logNote 不写 aut.note', JSON.stringify({ log: 四.log.at(-1), note: 四.note }))

    查(改自主(根, () => false) === null, '改·返回 false 就不写')
    查(真位(根) === '超市', '真位·读资产')

    // 原子的原子性测不出来（单线程顺序写永远过），只能断言结构
    const 底 = readFileSync(join(路径根, '_底层.mjs'), 'utf8')
    // LOCKNAME_FIX 2026-11-24：锁名从 `basename(p)` 改成 `父目录名 + '__' + basename(p)`，
    // 断言钉的是「先抢锁再读」这个结构，不能写死锁名拼法。改成认 `加锁(` 出现在 改档 前面。
    查(/export function 改档[\s\S]{0,500}加锁\(/.test(底), '_底层.改档 先抢锁再读')
    查(/export function 改档[\s\S]{0,600}写档\(/.test(底), '_底层.改档 用原子写档')
  } finally { rmSync(根, { recursive: true, force: true }) }
}

// ── 在干嘛：state → 活动档，只有这一处 ─────────────────────────────────
// 批次170：三份清单（状态推进 的数组、困意 的正则、饱渴 的 if 链）已经分叉 ——
// 她在「看B站」时体力按干活扣、困意按歇着攒。这里把分档钉住。
{
  const 该 = {
    睡觉: '睡', 睡: '睡', 睡岗: '睡',
    打瞌睡: '盹', 打盹: '盹',
    刷手机: '歇', 玩电脑: '歇', 发呆: '歇', 摸鱼: '歇', 翻旧账: '歇', 学点东西: '歇', 待命: '歇', 看B站: '歇', 逛贴吧: '歇',
    吃点东西: '轻', 拍张照: '轻', 洗澡: '轻', 吃饭: '轻',
    打工: '中', 上班: '中', 站立: '轻', 站柜台: '中', 走动: '中', 逛街: '中',
    搬货: '重', 跑: '重',
  }
  const 错 = Object.entries(该).filter(([k, v]) => 档(k) !== v)
  查(!错.length, '在干嘛·六档分对', JSON.stringify(错))
  查(档('') === '轻' && 是歇着('') === false, '在干嘛·空串按轻（读不到不白送体力）')
  查(倍率('睡觉') === 0.4 && 倍率('打盹') === 0.4 && 倍率('发呆') === 1.0 &&
     倍率('打工') === 1.25 && 倍率('走动') === 1.4 && 倍率('逛街') === 1.6 &&
     倍率('搬货') === 1.9 && 倍率('跑') === 2.0, '在干嘛·倍率',
     ['睡觉', '打盹', '发呆', '打工', '走动', '逛街', '搬货', '跑'].map((k) => k + '=' + 倍率(k)).join(' '))
  查(是歇着('打瞌睡') && 是歇着('看B站') && !是歇着('拍张照') && !是歇着('打工'), '在干嘛·是歇着')
  查(说法('翻旧账') === '想以前的事' && 说法('看B站') === '看视频' && 说法('逛贴吧') === '逛贴吧',
    '在干嘛·对外说法')

  // 结构断言：这几个文件不许再自己列 state 清单（注释里提到不算）
  const 私 = ['状态推进.mjs', '困意.mjs', '饱渴.mjs', '同步QQ状态.mjs'].filter((f) => {
    const 行们 = readFileSync(join(路径根, f), 'utf8').split('\n')
    return 行们.some((行) => {
      const t = 行.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
      return /发呆|摸鱼|翻旧账|看B站|逛贴吧/.test(t)
    })
  })
  查(!私.length, '在干嘛·三个调用方不再自己列清单（含结构扫）', 私.join('、'))
}

// ── 精力合成：只有 恢复目标.精力() 一处 ────────────────────────────────
// 批次171：原来两套公式并存 —— 状态推进/困意/洗澡 用木桶，作息(睡醒结算)/奖惩 用两数平均。
// 她认知 25 时两者差 15 点：睡醒写 58，10 分钟后 状态推进 重算成 43，面板上就是「一觉醒来掉 15」。
{
  查(精力({ physical: 60, cognitive: 25, emotional: 55 }) === 43, '精力·木桶（认知低时 43，不是平均 58）',
    精力({ physical: 60, cognitive: 25, emotional: 55 }))
  查(精力({ physical: 55, cognitive: 55, emotional: 55 }) === 56, '精力·三层相等', 精力({ physical: 55, cognitive: 55, emotional: 55 }))
  查(精力({ physical: 100, cognitive: 100, emotional: 100 }) === 100, '精力·满了封顶', 精力({ physical: 100, cognitive: 100, emotional: 100 }))
  查(精力({ physical: 0, cognitive: 0, emotional: 0 }) === 1, '精力·全空也不会负', 精力({ physical: 0, cognitive: 0, emotional: 0 }))
  查(Number.isFinite(精力({ physical: 50, cognitive: 50 })), '精力·emotional 缺失不出 NaN', 精力({ physical: 50, cognitive: 50 }))
  查(精力({}) === 精力({ physical: 45, cognitive: 45, emotional: 45 }), '精力·全缺字段按 45 兜底', 精力({}))

  // 结构：不许再手抄 pow(...,0.6) 那份木桶
  const 私乘 = ['状态推进.mjs', '困意.mjs', '作息.mjs', '奖惩.mjs', '洗澡.mjs', '资产.mjs'].filter((f) => {
    return readFileSync(join(路径根, f), 'utf8').split(String.fromCharCode(10)).some((行) => {
      const t = 行.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
      // 两种手抄：木桶 pow(...,0.6)，和 两数平均 (physical + emotional) / 2。
      // 批次173：资产.mjs 就是「平均」那一版漏网的 —— 只扫 pow 抓不到它。
      if (t.includes('Math.pow') && t.includes('0.6')) return true
      return t.includes('energy =') && t.includes('emotional') && t.includes('/ 2')
    })
  })
  查(!私乘.length, '精力·合成公式只有 恢复目标.mjs 一处', 私乘.join('、'))
}

// ── 在岗：一个事实一处判（批次172）──────────────────────────────────────
// 原来 工作.mjs 写 `位 === 班.点 && !途中`，占用.在岗的班 只看「状态=在岗」。
// 她 22:00 在便利店打卡、05:54 走回家，06:00 到家时状态还是「在岗」：
//   · 同步QQ状态 说「在家上便利店夜班」
//   · 缺口 / 自主行动 / 自动作息 都判她走不开
//   · 工作.mjs 把它当成「人没到」，记「迟到 474 分钟」扣 20 块
{
  const 根 = mkdtempSync(join(tmpdir(), '自检-在岗-'))
  try {
    const 班 = { id: 'b1', 点: '便利店', 活: '夜班', 起: '2026-11-06 22:00', 止: '2026-11-07 06:00', 状态: '在岗', 打卡At: '2026-11-06 22:00', 在岗分钟: 475, 记迟到: 0, 时薪: 19 }
    const 京 = (x) => Date.parse(x.replace(' ', 'T') + '+08:00')
    const 夜中 = 京('2026-11-07 02:00')
    const 走时 = 京('2026-11-07 05:54')
    const 迟 = (动作) => 动作.filter((a) => a.t === '迟到')
    const 局 = (资, now) => ({ 配: {}, 工: { 班次: [{ ...班 }] }, 资, 睡: false, 睡起: 0, now, 掷: () => 1 })

    查(算在岗(班, { 位置: '便利店' }, 夜中) === true, '在岗·人在店里算')
    查(算在岗(班, { 位置: '家' }, 夜中) === false, '在岗·人不在店里不算')
    查(算在岗(班, { 位置: '便利店', 在途: { arriveAt: 走时 + 36e5 } }, 走时) === false, '在岗·在途不算')
    查(算在岗(班, {}, 夜中) === false, '在岗·位置不知道时交调用方保守处理')

    writeFileSync(join(根, '工作.json'), JSON.stringify({ 班次: [班] }))
    writeFileSync(join(根, '资产.json'), JSON.stringify({ 位置: '便利店' }))
    查(在岗的班(根, 夜中)?.id === 'b1', '在岗的班·人在店里')
    writeFileSync(join(根, '资产.json'), JSON.stringify({ 位置: '家' }))
    查(在岗的班(根, 夜中) === null, 
      '在岗的班·人回家就没班', JSON.stringify(在岗的班(根, 夜中)))
    writeFileSync(join(根, '资产.json'), JSON.stringify({}))
    查(在岗的班(根, 夜中)?.id === 'b1', '在岗的班·位置读不到时保守算在岗')

    查(迟(判定(局({ 位置: '便利店' }, 夜中))).length === 0, '判定·在店里不记迟到')
    查(迟(判定(局({ 位置: '家' }, 走时))).length === 0, '判定·打过卡的人离开不记迟到',
      JSON.stringify(判定(局({ 位置: '家' }, 走时))))
    const 没打卡 = { ...班, 状态: '待上', 打卡At: '' }
    查(迟(判定({ 配: {}, 工: { 班次: [没打卡] }, 资: { 位置: '家' }, 睡: false, 睡起: 0, now: 京('2026-11-06 22:34'), 掷: () => 1 }))[0]?.分钟 === 34,
      '判定·没打卡的照记迟到')

    // 结构：迟到判据必须看「打过卡没有」；主流程不能在被 import 时跑
    const 工作源 = readFileSync(join(路径根, '工作.mjs'), 'utf8')
    查(工作源.includes('!String(班.打卡At'), '工作·迟到只对没打卡的班判')
    查(工作源.includes('const 是主'), '工作·被 import 时不再跑主流程')
  } finally { rmSync(根, { recursive: true, force: true }) }
}

// ── 状态.json 的写入：只合并自己改过的键（批次173）──────────────────────
// 批次173 量出来的：作息/撤回/资产 三处（五个调用）用 写档 整份覆盖 状态.json。
// 四个进程同时「读 → 等 40ms → 改 → 写」，裸写只有 1/4 个字段更新成功。
{
  const 根 = mkdtempSync(join(tmpdir(), '自检-状态-'))
  const p = join(根, '状态.json')
  try {
    writeFileSync(p, JSON.stringify({ energy: 1, mood: { intensity: 0, drive: 'calm' }, layers: { physical: 1, emotional: 45 } }))
    const st = loadState(p, {})
    const snap = clone(st)
    st.layers.physical = 69                 // 我改这个
    st.energy = 69
    // 模拟「我算的这段时间里，别人也写了」
    const 别人 = loadState(p, {})
    别人.mood.intensity = 0.8               // 别人改的兄弟键
    别人.mood.drive = 'happy'
    别人.新字段 = 7                          // 别人新增的键
    writeFileSync(p, JSON.stringify(别人))
    saveState(p, st, snap)
    const 终 = loadState(p, {})
    查(终.layers.physical === 69 && 终.energy === 69, 'saveState·自己改的写进去了', JSON.stringify(终))
    查(终.mood.intensity === 0.8, 'saveState·别人改的兄弟键保住了', 终.mood)
    查(终.mood.drive === 'happy', 'saveState·别人的另一个兄弟键也在', 终.mood)
    查(终.新字段 === 7, 'saveState·别人新增的键没被删', 终.新字段)
    查(终.layers.emotional === 45, 'saveState·没动过的子键原样', 终.layers)
  } finally { rmSync(根, { recursive: true, force: true }) }
}

// ── 账本：一条记录值多少钱，只有一处（批次174）──────────────────────────
// 三处（写日记/快照/日报）+ 面板两处各自解析，同一天能算出三个数：
//   11-05 真相 164/780   写日记 154/0   快照 154/780   日报 164/0
//   11-07 真相  83/250   写日记  83/0   快照  83/100   日报  83/0
{
  const 该 = [
    ['打工赚了 20', 0, 20, 0],                       // 没有「块」字，快照和日报原来全漏
    ['买了 台灯（-40）', 40, 0, 0],                   // 括号负数，快照和日报原来全漏
    ['上班：便利店夜班（475 分钟，130 块，扣了 20）', 0, 130, 0],  // 新工资格式，三处全漏
    ['还雨伞，退回押金 10 块', 0, 10, 0],              // 是进项，日报原来算成花了 10
    ['借雨伞押金 10 块（便利店）', 10, 0, 0],
    ['主人拿走 135 块', 0, 0, 135],                   // 单列，不混进「花了」
    ['主人给了 30 块', 0, 30, 0],
    ['买了糖（6 块）', 6, 0, 0],
    ['走到了便利店', 0, 0, 0],
  ]
  const 错 = 该.filter(([t, 花, 赚, 被拿]) => {
    const x = 一笔(t)
    return x.花 !== 花 || x.赚 !== 赚 || x.被拿 !== 被拿
  })
  查(!错.length, '账本·金额与方向', JSON.stringify(错.map(([t]) => [t, 一笔(t)])))
  查(一笔('上班：便利店夜班（475 分钟，130 块，扣了 20）').赚 === 130, '账本·分钟不是钱')
  查(一笔(null).花 === 0 && 一笔(123).赚 === 0, '账本·怪输入不炸')

  const 记录 = [
    { at: "2026-11-07 00:00", what: "买了自热饭（15 块）" },
    { at: "2026-11-07 06:00", what: "上班：便利店夜班（475 分钟，130 块，扣了 20）" },
    { at: "2026-11-06 22:00", what: "买了水（2 块）" },
  ]
  查(某天(记录, '2026-11-07').花 === 15 && 某天(记录, '2026-11-07').赚 === 130, '账本·某天只算那一天',
    JSON.stringify(某天(记录, "2026-11-07")))
  查(某天(记录, '2026-11-07').笔 === 2, '账本·笔数只数有金额的')
  查(汇总([]).笔 === 0 && 汇总(null).花 === 0, '账本·空输入')

  // 结构：账本里的每一种写法都得能被认出来 —— 拿线上真账跑一遍，
  // 凡是「带数字却算不出钱」的形状，要么是真没钱（走路/睡觉），要么是漏了一种写法。
  const 资 = 读档(join(路径根, "..", "记忆", "资产.json"), { 记录: [] })
  const 漏 = []
  const 见过 = new Set()
  for (const r of 资.记录 || []) {
    const t = String(r.what || "")
    if (!/[0-9]/.test(t)) continue
    const 形状 = t.replace(/[0-9]+(\.[0-9]+)?/g, "N")
    if (见过.has(形状)) continue
    见过.add(形状)
    const x = 一笔(t)
    if (!x.花 && !x.赚 && !x.被拿 && /块|分钟|赚|给了|押|价|费/.test(t)) 漏.push(t.slice(0, 40))
  }
  查(!漏.length, '账本·线上账本里每种带钱的写法都认得', 漏.join(' ｜ '))
}

// ── 链作废：作废表里的时间戳必须真的在链里 ──────────────────────────
// 作废表是按时间戳（条目唯一键）匹配的。打错一个字符，那条就会静默地继续注入 ——
// 而这个文件正是用来挡「不该进上下文的东西」，它自己失效不会有任何症状。
{
  try {
    const 链P = '{{BOT_ROOT}}/记忆/链.md'
    const 废P = '{{BOT_ROOT}}/记忆/链-作废.json'
    if (!existsSync(链P)) {
      console.log('  · 跳过「链作废」：还没有 链.md')
    } else {
      const 链全文 = readFileSync(链P, 'utf8')
      const 有 = (at) => 链全文.includes('## ' + at)
      if (!existsSync(废P)) {
        查(true, '链作废·没有作废表时链正常读', '')
      } else {
        const 表 = JSON.parse(readFileSync(废P, 'utf8'))
        const 条目 = Array.isArray(表['条目']) ? 表['条目'] : []
        const 找不到 = 条目.filter((x) => !有(String(x['at'] || '')))
        查(!找不到.length, '链作废·每一条都能在链里找到（' + 条目.length + ' 条）',
          找不到.length ? '找不到：' + 找不到.map((x) => x['at']).join('、') : '')
        const at们 = 条目.map((x) => String(x['at']))
        查(new Set(at们).size === at们.length, '链作废·没有重复作废',
           at们.filter((x, i) => at们.indexOf(x) !== i).join('、'))
        查(条目.every((x) => String(x['因'] || '').trim() !== ''), '链作废·每条都写了为什么', '')
      }
    }
  } catch (e) {
    查(false, '链作废·检查能跑', e.message)
  }
}

// ── 偏好作废：工具侧和插件侧必须给出同一个结果 ─────────────────────────
// 同一条规则写了两处（`偏好.mjs` 的 剔掉作废 / 插件 poll.js 的 剔掉作废偏好），
// 因为插件是独立 npm 包、不能 import 工具目录。两处必然分叉 —— 用这条锁住。
{
  const 插件LIB = process.env.QQ_PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
  const 插件poll = join(插件LIB, 'poll.js')
  if (!existsSync(插件poll)) {
    console.log('  · 跳过「偏好作废·两侧一致」：插件不在（' + 插件LIB + '）')
  } else {
    try {
      const 工具侧 = await import('./偏好.mjs')
      const 插件侧 = await import(pathToFileURL(插件poll).href)
      const A = 插件侧.剔掉作废偏好
      const B = 工具侧.剔掉作废
      if (typeof A !== 'function' || typeof B !== 'function') {
        查(false, '偏好作废·两侧都导出判据', '插件侧=' + typeof A + ' 工具侧=' + typeof B)
      } else {
        const 案子 = [
          { 喜欢: ['a'], 讨厌: ['b'] },
          { 喜欢: ['a'], 讨厌: ['b', 'c'], 作废: [{ 类: '讨厌', 条: 'b' }] },
          { 喜欢: ['a', 'b'], 讨厌: ['b'], 作废: [{ 类: '讨厌', 条: 'b' }] },
          { 审美: [{ 对象: '短句' }, { 对象: '长句' }], 作废: [{ 类: '审美', 条: '短句' }] },
          { 喜欢: ['a'], 作废: [null, 'x', { 类: '喜欢' }] },
        ]
        const 不一致 = 案子.filter((o) => JSON.stringify(A(o)) !== JSON.stringify(B(o)))
        查(!不一致.length, '偏好作废·两侧判据一致（' + 案子.length + ' 个案子）', JSON.stringify(不一致[0] || ''))
        // 期望值也锁 —— 两侧都错的时候它们照样「一致」
        const r = A({ 讨厌: ['b', 'c'], 作废: [{ 类: '讨厌', 条: 'b' }] })
        查(JSON.stringify(r.讨厌) === '["c"]', '偏好作废·真把作废那条剔掉了', JSON.stringify(r.讨厌))
        查(A({ 讨厌: ['b'], 作废: [] }).讨厌.length === 1, '偏好作废·没作废的不动')
        查(A({ 讨厌: [] , 作废: [{ 类: '讨厌', 条: 'b' }] }).讨厌.length === 0, '偏好作废·空列表不炸')
      }
    } catch (e) {
      查(false, '偏好作废·两侧可加载', e.message)
    }
  }
}

// ── 正路径：睡醒结算真的结了 / 洗澡真的洗完了 ─────────────────────────
// POSITIVE_PATH 2026-11-12：这两条是被真事故逼出来的。
//   · endSleep 从 11-10 起每次都返回 ok:false（函数里引用了没定义的 stateSnap，被 catch 吞掉），
//     records / 欠觉账 / 醒来补课停了两天多 —— 而当时唯一测它的用例断言的是「锁被占用时必须失败」，
//     它永远失败，所以那条恒绿。
//   · 洗澡.mjs 的 洗完了() 同一类病（__stSnap），一到点就崩，洗澡中 永远清不掉。
// 只测「失败时要失败」拦不住「永远失败」。这里在沙盒里走一遍成功的路，断言**结果真的落盘了**。
// 子进程 + 环境变量隔离：ST_BASE / QQ_AUTONOMY_MEM / QQ_LOCK_DIR 全指进临时目录，不碰真档、不占真锁；
// 觉只造 45 分钟，不到 60 分钟不会触发 补课.mjs。
{
  const 根 = mkdtempSync(join(tmpdir(), '自检-正路径-'))
  const NODE = '/usr/local/bin/node'
  const 这里 = fileURLToPath(new URL('.', import.meta.url))
  const bj秒 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
  const bj分 = (ms) => bj秒(ms).slice(0, 16)
  const 净环境 = (多) => { const e = { ...process.env, ...多 }; delete e.NODE_OPTIONS; return e }
  try {
    const 眠 = join(根, '眠'); const 锁 = join(根, '锁'); const 澡 = join(根, '澡')
    for (const d of [眠, 锁, 澡]) mkdirSync(d, { recursive: true })
    const now = Date.now(); const t0 = now - 45 * 60e3
    writeFileSync(join(眠, '睡眠.json'), JSON.stringify({ sleeping: true, sleepSince: t0, segments: [{ start: bj秒(t0), phases: [] }], records: [], 欠: 5,
      live: { phase: 'N2', cycle: 1, deep_min: 10, light_min: 25, rem_min: 5, start: bj秒(t0), startMs: t0, lastTick: now - 60e3 } }))
    writeFileSync(join(眠, '状态.json'), JSON.stringify({ energy: 40, 困意: 30, mood: { intensity: 0 }, layers: { physical: 40, emotional: 50, cognitive: 60, existential: 49 }, 别人的字段: 7 }))
    writeFileSync(join(眠, '睡醒.json'), JSON.stringify({ sleeping: true, since: bj分(t0) }))
    writeFileSync(join(眠, '梦余味.json'), JSON.stringify({ date: bj秒(now).slice(0, 10), 好: true, 余味: '测', 情绪已用: false }))
    let 出 = ''
    try {
      出 = execFileSync(NODE, ['--input-type=module', '-e',
        "const m = await import(" + JSON.stringify(pathToFileURL(join(这里, '睡眠阶段.mjs')).href) + "); console.log(JSON.stringify(m.endSleep('自检')))"],
        // ST_NO_DREAM：endSleep 现在会在醒来那一刻生成梦（批次418），而它生成的新梦会覆盖
        // 上面刚造的 梦余味.json —— 好/坏是随机的，这条断言就会随机红。
        // 这里测的是「梦余味有没有进情绪、别人的字段有没有被盖」，不是「梦怎么生成」（那是 t422）。
        { encoding: 'utf8', timeout: 20000, env: 净环境({ ST_BASE: 眠, QQ_LOCK_DIR: 锁, QQ_CATCHUP_MEM: 眠, ST_NO_DREAM: '1' }) })
    } catch (e) { 出 = '子进程挂了：' + String(e.stderr || e.message).slice(0, 160) }
    let r = {}; try { r = JSON.parse(出.trim().split('\n').pop()) } catch { /* 下面按失败报 */ }
    const 眠后 = 读档(join(眠, '睡眠.json'), {}); const 态后 = 读档(join(眠, '状态.json'), {})
    查(r.ok === true, 'endSleep·正常的一觉返回 ok:true', 出.slice(0, 160))
    查(Array.isArray(眠后.records) && 眠后.records.length === 1, 'endSleep·records 记了这一觉', JSON.stringify(眠后.records || null).slice(0, 80))
    查(眠后.sleeping === false && 眠后.live === null, 'endSleep·睡眠标记翻回醒、live 清空', 'sleeping=' + 眠后.sleeping + ' live=' + (眠后.live === null ? 'null' : '还在'))
    // NAP_NOT_DEBT 2026-11-17（批次674）：这一觉只有 45 分钟，按打盹处理 ——
    // 打盹不记整夜的欠觉账（线上就是 4.9 分钟微睡被记了 +7.92），欠账应保持 5。
    查(Math.abs(Number(眠后.欠) - 5) < 0.05, 'endSleep·45 分钟打盹不记整夜欠觉账（保持 5）', String(眠后.欠))
    查(读档(join(眠, '睡醒.json'), {}).sleeping === false, 'endSleep·睡醒镜像同步')
    查(态后.layers && 态后.layers.emotional === 52 && 态后.别人的字段 === 7, 'endSleep·梦余味进了情绪、别人的字段没被盖', JSON.stringify(态后.layers || null))

    writeFileSync(join(澡, '卫生.json'), JSON.stringify({ 清洁: 40, 上次洗: '', 次数: 0, 上次更新: bj分(now),
      洗澡中: { 开始: bj分(now - 30 * 60e3), 结束: bj分(now - 5 * 60e3), 到: 92, 为什么: '', 在哪: '家' } }))
    writeFileSync(join(澡, '状态.json'), JSON.stringify({ energy: 40, layers: { physical: 40, emotional: 50, cognitive: 60, existential: 49 } }))
    writeFileSync(join(澡, '自主' + '.json'), JSON.stringify({ state: '洗澡' }))
    writeFileSync(join(澡, '资产.json'), JSON.stringify({ 位置: '家', 钱: 100, 记录: [] }))
    writeFileSync(join(澡, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj分(now - 3600e3) }))
    let 澡码 = 0; let 澡错 = ''
    try { execFileSync(NODE, [join(这里, '洗澡.mjs'), '--tick'], { encoding: 'utf8', timeout: 20000, env: 净环境({ QQ_AUTONOMY_MEM: 澡, QQ_LOCK_DIR: 锁 }) }) }
    catch (e) { 澡码 = e.status ?? 1; 澡错 = String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || '' }
    const 卫后 = 读档(join(澡, '卫生.json'), {})
    查(澡码 === 0, '洗澡·到点的 --tick 正常退出', 澡错.slice(0, 120))
    查(!卫后.洗澡中 && 卫后.次数 === 1 && 卫后.清洁 === 92, '洗澡·洗完了：洗澡中 清掉、次数 +1、清洁到 92', JSON.stringify({ 洗澡中: !!卫后.洗澡中, 次数: 卫后.次数, 清洁: 卫后.清洁 }))
  } catch (e) {
    查(false, '正路径·检查能跑', e.message)
  } finally { rmSync(根, { recursive: true, force: true }) }
}

// ── 汇总 ──────────────────────────────────────────────────────────────
const 详情 = process.argv.includes('--详情')
if (详情) for (const x of 好) console.log('  ✓ ' + x)
console.log(`底座自检：${好.length} 通过 / ${坏.length} 不对`)
if (坏.length) process.exit(1)
}
