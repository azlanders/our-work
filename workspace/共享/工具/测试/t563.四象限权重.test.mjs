// t563 —— 精力/体力/困意联动：四象限权重模型（批次563）
//
// 主人原话：「精力体力和困意联动，其中体力占比大、精力占比较小；
//   困意高体力低   → 更倾向于直接床上睡觉
//   困意低体力低   → 倾向于进行休息（坐着躺着刷手机看B站贴吧或发呆）
//   困意高体力高   → 倾向于打盹
//   困意低体力高   → 就不用我讲了
//   精力则在此基础上小幅度倾向影响，如精力低更消极
//   （因为体力层也会影响精力，所以要着重考虑设计）」
//
// 这一批把「困意 >= 78 就清空池子硬推打瞌睡」换成了「按象限给票、一起抽」——
// 主人说的是**倾向**，不是必须。所以测试也必须是**分布测试**：跑很多次看比例，
// 不能只跑一次看结果（一次的结果就是抛硬币）。
//
// 全部在沙盒里跑：`--dry` 不写任何档，且 base/env 全指向 mkdtemp，
// 结尾 after() 比对真档四个文件的 size+mtime。
import { test, after } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => readFileSync(p, 'utf8')
const 指纹 = (p) => { try { const s = statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return '(无)' } }

// NAP_SLIDE 2026-11-16（批次569）：整觉判据搬进 自主判据.该滑入整觉（两处共问一份），
// 所以 A3 改成**测行为**，不再钉源码那一行 —— 实现一搬家就红的断言，
// 正是本文件开头那第 6 条判据的反面例子（t558/t559 栽过两次）。
const { 该滑入整觉 } = await import(工具 + '/自主判据.mjs')

// PHONE_PC 2026-11-16（批次570）：生产把 发呆 拆成 刷手机/玩电脑 了，这份镜像清单也要跟上
// —— 不然 B2 量出来的「休息类占比」凭空少一截（实测 4/5 次红）。发呆 留着读旧台账。
const 消极类 = ['刷手机', '玩电脑', '发呆', '摸鱼', '看B站', '逛贴吧', '翻旧账', '琢磨黑话', '躺着']
const 积极类 = ['走动', '学点东西', '拍张照', '打零工', '逛街']

/** 造一个「醒着、手头没事」的沙盒。 */
function 沙盒({ physical, 困意, energy }) {
  const d = mkdtempSync(join(tmpdir(), 't563-'))
  for (const f of ['状态.json', '资产.json', '饱渴.json', '饥饿.json', '卫生.json', '工作.json', '自主.json', '天气.json', '疾病.json']) {
    try { writeFileSync(join(d, f), 读(join(真档, f))) } catch { writeFileSync(join(d, f), '{}') }
  }
  // 占位档全部清掉 —— 有它们会在「在打盹 / 在吃饭 / 在洗澡 / 在睡」那几步直接 exit，
  // 拿不到池子（这就是「测试环境没搭对，测出来的是别的东西」）。
  for (const f of ['打盹.json', '吃饭.json', '打盹-末次.json']) {
    try { unlinkSync(join(d, f)) } catch { /* 本来就没有 */ }
  }
  // HUNGER_NEUTRAL 2026-11-17（批次636）：复制真档会把“她此刻饿/渴”带进象限测试，
  // 饥饿/喝水票会压过睡眠票（实测 B1 最高变成“吃点东西”）。给中性饱水状态，
  // 让这里只测 体力×困意；真实饥饿对行动的影响另有测试。
  writeFileSync(join(d, '饱渴.json'), JSON.stringify({
    血糖: 6.5, 水: 1600, 卡: 1600, 胃: 800, 欠: 0, 账: [],
  }))
  const st = JSON.parse(读(join(d, '状态.json')))
  st['困意'] = 困意
  st.energy = energy
  st.layers = { ...(st.layers || {}), physical }
  // QUADRANT_ISOLATE 2026-11-17（批次652）：**认知/存在层和清醒时长也必须置中。**
  // 原来只改了 physical，其余三层照抄生产档。线上那一刻是 cognitive 19.8、
  // hoursAwake 21.5 —— 正好命中「累到必须打盹」（lowBody <= 20 且清醒 >= 3h）
  // 那条**清池硬推**分支，B4（困 25 体力 75，期望打瞌睡 0 票）被硬塞成 60 票。
  // 那不是象限模型坏了，是夹具把「她已经撑了 21 小时」带进来了。
  st.layers = { ...st.layers, cognitive: 70, emotional: 55, existential: 55 }
  st.hoursAwake = 2
  delete st['熬夜']       // 熬夜.over 会叠加到困意上，会把「困意 25」变成 60+
  delete st['清醒时长']    // 有值就不走倒推，避免它干扰（这条不影响本测试，但少一个变量）
  writeFileSync(join(d, '状态.json'), JSON.stringify(st))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: '2026-11-16 09:00:00' }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ records: [], segments: [], sleeping: false, live: null }))
  const 卫 = JSON.parse(读(join(d, '卫生.json')) || '{}')
  delete 卫['洗澡中']
  卫['清洁'] = 80                     // 别让洗澡票抢戏
  writeFileSync(join(d, '卫生.json'), JSON.stringify(卫))
  // AUTONOMY_ISOLATE 2026-11-17（批次652）：**自主.json 也要清干净。**
  // 原来整份照抄生产档，里面带着她真实的 aut.log —— push() 有一条
  // 「同一件事刚做过就降权」（连续两次 ×0.45、三次 ×0.25），
  // 生产 log 里最近恰好有打瞌睡，于是 B1 的打瞌睡票从 22 掉到 5，输给了喝水。
  // 这里测的是象限权重，不该被她此刻在干嘛左右。
  writeFileSync(join(d, '自主.json'), JSON.stringify({
    state: '', since: Date.now(), nextAt: 0, doneAt: 0, log: [],
  }))
  return d
}

function 一次(d) {
  const r = spawnSync(process.execPath, [join(工具, '自主行动.mjs'), '--dry'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_AUTONOMY_MEM: d, ST_BASE: d, QQ_SLEEP_MEM: d, NAP_MEM: d, QQ_SLEEPY_MEM: d },
  })
  const out = String((r.stdout || '') + (r.stderr || ''))
  const m = out.match(/现在去「(.+?)」/)
  return {
    动作: m ? m[1] : '',
    整觉: out.includes('会去睡整觉'),
    打盹分钟: /会眯 \d+ 分钟/.test(out),
    票: (() => { const x = out.match(/打瞌睡票 (\d+)\/(\d+)/); return x ? { 有: Number(x[1]), 总: Number(x[2]) } : null })(),
    out,
  }
}

/** 跑 n 次，返回分布。 */
// T7 / T5 2026-11-16（批次570）：**30 次采样贴不住阈值。**
// 实测：单跑 9 次全绿，整套里红了 2 次（B2 一次、另一次没抓到名字）—— 红的是 σ，不是功能。
// 样本翻倍：σ 降 1/√2，代价是每次多跑 30 遍 自主行动（整套约 +20 秒）。
function 分布(条件, n = 60) {
  const d = 沙盒(条件)
  try {
    const 计 = {}
    const 样本 = []
    for (let i = 0; i < n; i += 1) {
      const r = 一次(d)
      if (!r.动作) throw new Error('没抽到动作，输出：' + r.out.slice(-300))
      计[r.动作] = (计[r.动作] || 0) + 1
      样本.push(r)
    }
    const 占比 = (名单) => 名单.reduce((a, k) => a + (计[k] || 0), 0) / n
    return { 计, 样本, 占比, n }
  } finally { rmSync(d, { recursive: true, force: true }) }
}

// GUARD_BY_VALUE 2026-11-16（批次564b）：**真档防线不能看 mtime。**
// 线上心跳每分钟都在写 状态.json（睡眠心跳 tickSleep / 自主行动），mtime 必然变 ——
// 实测这套断言 10 次里红 1 次，红的还都是「大小没变、只是时间戳变了」的假警报。
// 一条会随机红的防线比没有更糟：它会训练人忽略红灯（这条教训当天已经吃过一次）。
// 改成看「测试造的那些特征值有没有落进真档」—— 困意 130 / 106、体力 0 是真档不可能出现的组合。
const 真档特征 = () => {
  try {
    const st = JSON.parse(读(join(真档, '状态.json')))
    return { 困意: Number(st['困意']), 体力: Number(st.layers?.physical) }
  } catch { return { 困意: NaN, 体力: NaN } }
}
after(() => {
  const 后 = 真档特征()
  const 撞 = 后['困意'] === 130 || 后['困意'] === 106 || 后['体力'] === 0
  assert.ok(!撞, '真档 状态.json 出现测试特征值（困意 ' + 后['困意'] + ' / 体力 ' + 后['体力'] + '）—— 沙盒变量漏了一个')
  // 不再断言「真档 打盹.json 必须为空」：她真的在打盹时这个文件本来就非空，
  // 而测试跑 `--dry` 不会写它。旧断言会把「她正在睡」误判成测试污染，
  // 一条会跟生产状态打架的防线比没有更糟。真档特征值仍由上面那条守住。
})

test('A1 象限系数只吃 体力×困意定象限，精力只做小幅修饰（不许拿 energy 定象限）', () => {
  const s = 读(工具 + '/自主行动.mjs')
  assert.ok(s.includes('function 象限系数(name)'), '没有 象限系数')
  const i = s.indexOf('function 象限系数(name)')
  const 段 = s.slice(i, i + 1400)
  // 定象限只用 physical + sleepy
  // 体力读在 体力线() 里（象限系数 调它），不在函数体里直接出现
  assert.ok(段.includes('体力线()'), '没读体力（应调 体力线()）')
  assert.match(s.slice(i - 400, i + 100), /const 体力线 = \(\) => Number\(st\?\.layers\?\.physical/, '体力线 没读 layers.physical')
  assert.match(段, /sleepy/, '没读困意')
  // 精力只出现在最后的乘数里，且最大 1.2 / 最小 0.8
  const 乘 = 段.match(/k \*= 消沉 \? ([\d.]+) : 振作 \? ([\d.]+) : 1/g) || []
  assert.ok(乘.length >= 2, '精力修饰没写全（消极/积极各一处）')
  for (const m of 乘) {
    for (const v of m.match(/[\d.]+/g) || []) {
      const x = Number(v)
      assert.ok(x >= 0.75 && x <= 1.3, '精力修饰幅度越界：' + v + '（主人要「小幅度」）')
    }
  }
})

test('A2 不许再清池硬推（主人说的是「倾向于」）', () => {
  const s = 读(工具 + '/自主行动.mjs')
  const 码 = s.split('\n').filter((ln) => !ln.trim().startsWith('//') && !ln.trim().startsWith('*')).join('\n')
  // 除了「熬穿 >= 105」那条生理上限，任何地方都不许在困意分支里清池
  const 清池 = 码.match(/choices\.length = 0/g) || []
  assert.ok(清池.length <= 2, '清池出现了 ' + 清池.length + ' 次（只允许 熬穿 + 体力见底 两条生理上限）')
  assert.ok(码.includes('自主_熬穿困意'), '熬穿那条生理上限不见了')
})

test('A3 整觉判据要看体力（困意 55 + 体力低 就该整觉，不再死等 95）', () => {
  assert.equal(该滑入整觉(55, 38), true, '困意 55 + 体力 38 还不整觉（死等 95）')
  assert.equal(该滑入整觉(55, 60), false, '体力还够也整觉 —— 「困低体力低」那条没了')
  assert.equal(该滑入整觉(95, 100), true, '困到 95 不整觉')
  assert.equal(该滑入整觉(94, 100), false, '没到 95 就整觉')
  // 两份调用都还接在这条判据上（抽中打瞌睡 / 打盹途中滑入）
  const src = 读(工具 + '/自主行动.mjs')
  assert.ok((src.match(/该滑入整觉\(/g) || []).length >= 2, '自主行动 里少于 2 处调用 —— 打盹途中那处没接上')
})

test('B1 困高体力低 → 打瞌睡票最多，抽中就是整觉', () => {
  const r = 分布({ physical: 30, 困意: 85, energy: 50 })
  const 睡 = r.计['打瞌睡'] || 0
  const 最多 = Object.entries(r.计).sort((a, b) => b[1] - a[1])[0]
  assert.equal(最多[0], '打瞌睡', '最多的是「' + 最多[0] + '」不是打瞌睡：' + JSON.stringify(r.计))
  assert.ok(睡 / r.n >= 0.25, '打瞌睡只占 ' + Math.round(睡 / r.n * 100) + '%（期望 >= 25%）')
  // 上界：旧代码在这里是**清池硬推**，占比恒为 100%。不清池就必然留出别的手气，
  // 这条是唯一能区分「加权」和「清池」的量化断言（反向验证里 B2~B7 都抓不住旧代码）。
  assert.ok(睡 / r.n <= 0.85, '打瞌睡占 ' + Math.round(睡 / r.n * 100) + '% —— 这已经是清池硬推了，不是倾向')
  const 抽中的 = r.样本.filter((x) => x.动作 === '打瞌睡')
  assert.ok(抽中的.every((x) => x.整觉), '困高体力低却只打盹不整觉：' + 抽中的.slice(0, 2).map((x) => x.out.slice(-80)))
})

test('B2 困低体力低 → 不许整觉，休息类占大头', () => {
  const r = 分布({ physical: 30, 困意: 25, energy: 50 })
  const 睡 = r.计['打瞌睡'] || 0
  assert.ok(睡 / r.n <= 0.15, '不困不累却 ' + Math.round(睡 / r.n * 100) + '% 去打瞌睡：' + JSON.stringify(r.计))
  assert.equal(r.样本.filter((x) => x.整觉).length, 0, '困意 25 还去睡整觉')
  const 休 = r.占比(消极类)
  assert.ok(休 >= 0.55, '休息类只占 ' + Math.round(休 * 100) + '%（期望 >= 55%）：' + JSON.stringify(r.计))
})

test('B3 困高体力高 → 抽中只打盹（不整觉）', () => {
  const r = 分布({ physical: 75, 困意: 85, energy: 50 })
  const 睡 = r.计['打瞌睡'] || 0
  // 门槛留够余量：期望约 30%，30 次采样 σ≈8%，写 10% 会隔几次红一次（会训练人忽略红灯）
  assert.ok(睡 / r.n >= 0.08, '困高体力高只 ' + Math.round(睡 / r.n * 100) + '% 去打瞌睡：' + JSON.stringify(r.计))
  const 抽中的 = r.样本.filter((x) => x.动作 === '打瞌睡')
  assert.ok(抽中的.every((x) => !x.整觉), '体力还够 75 就去睡整觉了（该只打盹）')
  assert.ok(抽中的.every((x) => x.打盹分钟), '抽中打瞌睡却没眯（输出：' + 抽中的[0].out.slice(-120) + '）')
})

test('B4 困低体力高 → 打瞌睡票为 0（不困不累就不想睡）', () => {
  const r = 分布({ physical: 75, 困意: 25, energy: 50 })
  assert.equal(r.计['打瞌睡'] || 0, 0, '不困不累还去睡：' + JSON.stringify(r.计))
  assert.equal(r.样本.filter((x) => x.整觉).length, 0)
})

// 这一条原来测「精力低 → 躺着/发呆 更多」。三个层面都不对：
//   ① 消极类在「困低体力低」格里本来就占八成，整体 ×1.2 分子分母一起涨，占比几乎不动；
//   ② 想让差异明显就得加大倍数，实测 1.4 把这一对从 23% 推到 67% —— 那是主导不是修饰；
//   ③ 主人要的「精力低更消极」已经由 B6（积极类变少）直接测出来了。
// 换成真正该锁的那件事：**精力不参与定象限** —— 打瞌睡票只由 体力×困意 决定。
// 票数是确定值（--dry 一次就够），不吃抽签噪声。
test('B5 精力不许影响「睡不睡」—— 打瞌睡票只由 体力×困意 决定', () => {
  const 票 = (energy) => {
    const d = 沙盒({ physical: 30, 困意: 25, energy })
    try { return 一次(d).票 } finally { rmSync(d, { recursive: true, force: true }) }
  }
  const a = 票(28)
  const b = 票(78)
  assert.ok(a && b, '没读到打瞌睡票（--dry 的日志变了？）')
  assert.equal(a.有, b.有, '精力从 28 到 78，打瞌睡票从 ' + a.有 + ' 变成 ' + b.有 + ' —— 精力不该管睡不睡')
})

// B6 原来测「精力低时积极类更少」。**删掉不是偷懒，是它测不出来：**
// 积极类基础票只有 6 份，±20% 的修饰在 30 次采样里是 3.6 次 vs 5 次 ——
// 泊松噪声比效应还大。整套跑的时候它红过一次（10% vs 3%），单独跑又绿 ——
// 一条会随机红的测试比没有测试更糟：它会训练人忽略红灯。
// 「精力只做小幅度修饰」这条已经由 A1（系数必须落在 0.75~1.3）和
// B5（精力不许影响睡不睡）确定性锁住。要测方向就得把样本拉到几百次，
// 那是另一个量级的时间预算，不值得为一条 ±20% 的修饰付。

// 边界值矩阵：阈值上最容易出「除以零 / 变 NaN / 池子空掉」这类事。
// 主人要「多环境测试」—— 正常四象限只是其中一格，卡在阈值上的才是真事故现场。
test('B8 边界：体力/困意/精力卡在阈值上下、全 0、全满、熬穿，都不能崩也不能空池', () => {
  const 组 = [
    ['体力正好低线 38', { physical: 38, 困意: 25, energy: 50 }],
    ['体力刚过线 39', { physical: 39, 困意: 25, energy: 50 }],
    ['困意正好过线 78', { physical: 30, 困意: 78, energy: 50 }],
    ['困意差一分 77', { physical: 30, 困意: 77, energy: 50 }],
    ['困意正好整觉线 55 且体力低', { physical: 30, 困意: 55, energy: 50 }],
    ['全 0', { physical: 0, 困意: 0, energy: 0 }],
    ['全满', { physical: 100, 困意: 100, energy: 100 }],
    // MICROSLEEP（566）：清池线 105→130，所以这两格改成 135 / 150
    ['熬穿 135', { physical: 30, 困意: 135, energy: 50 }],
    ['重度熬穿 150', { physical: 30, 困意: 150, energy: 50 }],
  ]
  const 结果 = {}
  for (const [名, c] of 组) {
    const d = 沙盒(c)
    try {
      const 计 = {}
      for (let i = 0; i < 8; i += 1) {
        const r = 一次(d)
        assert.ok(r.动作, '「' + 名 + '」空池 / 崩了，输出：' + r.out.slice(-240))
        计[r.动作] = (计[r.动作] || 0) + 1
        // 票数不能出现 NaN / 负数（权重算崩了会走到 Math.round(NaN)）
        if (r.票) assert.ok(r.票.总 > 0 && r.票.有 >= 0, '「' + 名 + '」票数不对：' + JSON.stringify(r.票))
      }
      结果[名] = 计
    } finally { rmSync(d, { recursive: true, force: true }) }
  }
  // 熬穿必须是硬上限：>= 105 时清池只留打瞌睡（这是生理上限，不是倾向）
  assert.deepEqual(Object.keys(结果['熬穿 135']), ['打瞌睡'], '熬穿 135 还在干别的：' + JSON.stringify(结果['熬穿 135']))
  assert.deepEqual(Object.keys(结果['重度熬穿 150']), ['打瞌睡'], '熬穿 150 还在干别的：' + JSON.stringify(结果['重度熬穿 150']))
})

test('B7 每个象限都不会抽出空池（兜底必须还在）', () => {
  for (const c of [
    { physical: 30, 困意: 85, energy: 50 }, { physical: 30, 困意: 25, energy: 50 },
    { physical: 75, 困意: 85, energy: 50 }, { physical: 75, 困意: 25, energy: 50 },
  ]) {
    const d = 沙盒(c)
    try {
      for (let i = 0; i < 6; i += 1) {
        const r = 一次(d)
        assert.ok(r.动作, '空池：' + JSON.stringify(c) + ' 第 ' + (i + 1) + ' 次，输出 ' + r.out.slice(-200))
      }
    } finally { rmSync(d, { recursive: true, force: true }) }
  }
})
