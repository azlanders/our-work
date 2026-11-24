// 排班判据 / 惦记 / _隧道 / _总线 —— 全是纯函数，一次收完引用表最后几项。
const 排 = await import('{{BOT_ROOT}}/共享/工具/排班判据.mjs')
const 惦 = await import('{{BOT_ROOT}}/共享/工具/惦记.mjs')
const 隧 = await import('{{BOT_ROOT}}/共享/工具/_隧道.mjs')
const 线 = await import('{{BOT_ROOT}}/共享/工具/_总线.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const T = Date.parse('2026-11-13T18:00:00+08:00')
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 班 = (起, 止, 状态 = '待上', 点 = '便利店') => ({ 点, 起: 北京(起), 止: 北京(止), 状态 })
const 时 = (h) => T + h * 3600e3

// ══════════ 排班判据·该去的班 ══════════
加('非数组 → null', 排.该去的班(null, T), null)
加('空数组 → null', 排.该去的班([], T), null)
加('状态=完成 → 跳过', 排.该去的班([班(时(0), 时(8), '完成')], T), null)
加('状态=缺勤 → 跳过', 排.该去的班([班(时(0), 时(8), '缺勤')], T), null)
加('状态=辞退 → 跳过', 排.该去的班([班(时(0), 时(8), '辞退')], T), null)
{
  const b = 班(时(0), 时(8))
  const r = 排.该去的班([b], T)
  加('正在班上 → 返回这条', r && r.点, '便利店')
  加('★ 正在班上 → 急 = 0', r && r.急, 0)
}
{
  // 提前 30 分钟：start - 30min 之前不叫
  加('★ 提前 31 分钟 → 还不该去', 排.该去的班([班(时(1), 时(9))], T), null)
  加('★ 提前 29 分钟 → 该去了', 排.该去的班([班(时(0.5), 时(8))], T) !== null, true)
}
加('已经过了下班时间 → null', 排.该去的班([班(时(-10), 时(-2))], T), null)
加('起止是坏的 → 跳过', 排.该去的班([{ 点: 'x', 起: '坏的', 止: '坏的', 状态: '待上' }], T), null)
加('没写状态也算（只排除三种）', 排.该去的班([{ 点: '便利店', 起: 北京(时(0)), 止: 北京(时(8)) }], T) !== null, true)
{
  // 两个班：一个已开始、一个还没 —— 优先已开始的（急 = 0）
  const 已开 = 班(时(-1), 时(7), '待上', '便利店')
  const 未开 = 班(时(0.3), 时(8), '待上', '街市')
  const r = 排.该去的班([未开, 已开], T)
  加('★ 已开始的优先于快开始的', r && r.点, '便利店')
  加('已开始那条急=0', r && r.急, 0)
}
{
  // 两个都急 → 取起得早的
  const a = 班(时(-5), 时(3), '待上', '街市')
  const b = 班(时(-1), 时(7), '待上', '便利店')
  const r = 排.该去的班([b, a], T)
  加('两条都急 → 取起始早的那条', r && r.点, '街市')
}

// ══════════ 排班判据·该赴的班 ══════════
{
  const b = 班(时(0), 时(8))
  加('没有班 → null', 排.该赴的班([], {}, T), null)
  加('★ 人已经在目标地点 → null（不用去）', 排.该赴的班([b], { 位置: '便利店' }, T), null)
  加('★ 在途且还没到 → null（已经在路上）', 排.该赴的班([b], { 位置: '家', 在途: { arriveAt: T + 60000 } }, T), null)
  加('在途但已经到点 → 不算在途了', 排.该赴的班([b], { 位置: '家', 在途: { arriveAt: T - 60000 } }, T) !== null, true)
  const r = 排.该赴的班([b], { 位置: '家' }, T)
  加('人在别处 → 返回并带「去哪」', r && r.去哪, '便利店')
  加('班没写地点 → null', 排.该赴的班([{ 起: 北京(时(0)), 止: 北京(时(8)), 状态: '待上' }], { 位置: '家' }, T), null)
}

// ══════════ 惦记·可顺嘴问 / 可记内心 ══════════
{
  const x = { what: '她说要还伞', who: '{{OWNER_UIN}}' }
  加('null → false', 惦.可顺嘴问(null, '{{OWNER_UIN}}'), false)
  加('不是对象 → false', 惦.可顺嘴问('x', '{{OWNER_UIN}}'), false)
  加('done:true → false', 惦.可顺嘴问({ ...x, done: true }, '{{OWNER_UIN}}'), false)
  加('没有 who → false', 惦.可顺嘴问({ what: 'x' }, '{{OWNER_UIN}}'), false)
  加('★ 生理惦记（该喝口水了）→ 不顺嘴问', 惦.可顺嘴问({ what: '该喝口水了', who: '{{OWNER_UIN}}' }, '{{OWNER_UIN}}'), false)
  加('★ 生理惦记（有点空了，找点吃的）→ 不顺嘴问', 惦.可顺嘴问({ what: '有点空了，找点吃的', who: '{{OWNER_UIN}}' }, '{{OWNER_UIN}}'), false)
  加('★ 不是这个人的 → false', 惦.可顺嘴问(x, '999999'), false)
  加('是这个人的 → true', 惦.可顺嘴问(x, '{{OWNER_UIN}}'), true)
  加('peer 是数字，x.who 是字符串 → 仍能对上', 惦.可顺嘴问(x, {{OWNER_UIN}}), true)
  加('peer 空 → 与 who 不等 → false', 惦.可顺嘴问(x, ''), false)
}
{
  加('可记内心：null → false', 惦.可记内心(null), false)
  加('可记内心：done → false', 惦.可记内心({ what: 'x', who: '1', done: true }), false)
  加('可记内心：没有 who → false', 惦.可记内心({ what: 'x' }), false)
  加('可记内心：生理惦记 → false', 惦.可记内心({ what: '该喝口水了', who: '1' }), false)
  加('★ 可记内心：不管是谁，都能记', 惦.可记内心({ what: '她说要还伞', who: '999' }), true)
}

// ══════════ _隧道 ══════════
加('域名：正常 URL', 隧.域名('https://www.bilibili.com/video/BV1'), 'www.bilibili.com')
加('域名：全大写 → 转小写', 隧.域名('https://WWW.BILIBILI.COM/x'), 'www.bilibili.com')
加('域名：带端口 → 只取主机名', 隧.域名('http://127.0.0.1:9880/tts'), '127.0.0.1')
加('域名：坏 URL → 空串', 隧.域名('坏的'), '')
加('域名：null → 空串', 隧.域名(null), '')
加('★ B 站走家宽（注释明确写了）', 隧.选出口('https://www.bilibili.com/x'), '家宽')
加('端口：墙外 = 7890', 隧.端口('墙外'), 7890)
加('端口：家宽 = 1080', 隧.端口('家宽'), 1080)
加('端口：未知出口 → 家宽 1080（默认）', 隧.端口('别的'), 1080)
加('代理参数：墙外是 http 代理', JSON.stringify(隧.代理参数('墙外')), JSON.stringify(['--proxy', 'http://127.0.0.1:7890']))
加('代理参数：家宽是 socks5-hostname', JSON.stringify(隧.代理参数('家宽')), JSON.stringify(['--socks5-hostname', '127.0.0.1:1080']))
加('代理参数：能指定端口', JSON.stringify(隧.代理参数('墙外', 9999)), JSON.stringify(['--proxy', 'http://127.0.0.1:9999']))
加('两个出口端口不同', 隧.墙外端口 !== 隧.家宽端口, true)

// ══════════ _总线·算激素心情偏置 ══════════
加('没传 → 全 0', JSON.stringify(线.算激素心情偏置()), JSON.stringify({ 情绪基线: 0, 心情偏: 0 }))
加('空对象 → 全 0（默认 45/25）', JSON.stringify(线.算激素心情偏置({})), JSON.stringify({ 情绪基线: 0, 心情偏: 0 }))
加('★ 多巴胺高 + 皮质醇低 → +2 / +0.15',
  JSON.stringify(线.算激素心情偏置({ dopamine: 70, cortisol: 30 })), JSON.stringify({ 情绪基线: 2, 心情偏: 0.15 }))
加('★ 皮质醇高 → -3 / -0.2',
  JSON.stringify(线.算激素心情偏置({ dopamine: 45, cortisol: 70 })), JSON.stringify({ 情绪基线: -3, 心情偏: -0.2 }))
加('★ 两个都高 → 皮质醇优先（-3）',
  JSON.stringify(线.算激素心情偏置({ dopamine: 70, cortisol: 70 })), JSON.stringify({ 情绪基线: -3, 心情偏: -0.2 }))
加('多巴胺差一点点（64）→ 不触发 +2',
  JSON.stringify(线.算激素心情偏置({ dopamine: 64, cortisol: 30 })), JSON.stringify({ 情绪基线: 0, 心情偏: 0 }))
加('皮质醇 65 整 → 触发 -3',
  JSON.stringify(线.算激素心情偏置({ dopamine: 45, cortisol: 65 })), JSON.stringify({ 情绪基线: -3, 心情偏: -0.2 }))
加('皮质醇 64 → 不触发',
  JSON.stringify(线.算激素心情偏置({ dopamine: 45, cortisol: 64 })), JSON.stringify({ 情绪基线: 0, 心情偏: 0 }))
加('★ 嵌套 {B:{...}} 也认',
  JSON.stringify(线.算激素心情偏置({ B: { dopamine: 70, cortisol: 30 } })), JSON.stringify({ 情绪基线: 2, 心情偏: 0.15 }))
加('NaN → 全 0', JSON.stringify(线.算激素心情偏置({ dopamine: NaN, cortisol: NaN })), JSON.stringify({ 情绪基线: 0, 心情偏: 0 }))
加('字符串数字 → 照算', JSON.stringify(线.算激素心情偏置({ dopamine: '70', cortisol: '30' })), JSON.stringify({ 情绪基线: 2, 心情偏: 0.15 }))

// ══════════ 事件总线：注册与查询 ══════════
{
  const 前 = 线.事件类型().length
  let 收到 = null
  线.注册事件('测试事件XYZ', (p) => { 收到 = p })
  加('注册后事件类型 +1', 线.事件类型().length, 前 + 1)
  加('新类型在列表里', 线.事件类型().includes('测试事件XYZ'), true)
  线.注册事件('测试事件XYZ', () => {})
  加('★ 重复注册同一类型 → 不增加类型数', 线.事件类型().length, 前 + 1)
}

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (JSON.stringify(实) === JSON.stringify(期)) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
