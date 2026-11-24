// 摘要可读化（批次389）：工具回填别再吐 JSON、对话别再显示注入块。
import { 摘要 } from '{{BOT_ROOT}}/共享/工具/usage-解析.mjs'

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])

// ── 工具回填 ──
const 工具请求 = (结果内容) => ({
  model: 'x',
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', name: 'qq_pass', id: 't1' }] },
    { role: 'user', content: [{ type: 'tool_result', content: 结果内容 }] },
  ],
})

let r = 摘要(工具请求([{ type: 'text', text: '划走了。这次不回了' }]))
加('A1 数组 → 抽出纯文本，不带 JSON', r.tip, 'qq_pass → 划走了。这次不回了')
加('A2 不含 [{"type"', r.tip.includes('[{"type"'), false)
加('A3 分类是工具回填', r.kind, '工具回填')

r = 摘要(工具请求('直接是字符串'))
加('A4 字符串 content 原样', r.tip, 'qq_pass → 直接是字符串')

r = 摘要(工具请求([{ type: 'text', text: '看到了' }, { type: 'image', source: {} }]))
加('A5 图文混排 → 图变成 [图]', r.tip, 'qq_pass → 看到了 [图]')

r = 摘要(工具请求([{ type: 'image_url', url: 'x' }]))
加('A6 纯图 → [图]', r.tip, 'qq_pass → [图]')

r = 摘要(工具请求([{ type: 'text', text: '一'.repeat(80) }]))
加('A7 超长截到 30 字以内', r.tip.length <= 40, true)

// ── 对话：注入剥离 ──
const 长注入 = '（关于他：称呼：主人；记得：' + '以前聊过很多事，'.repeat(20) + '）'
r = 摘要({ model: 'x', messages: [{ role: 'user', content: 长注入 + '[00:21] 你说的那个梗我真没懂' }] })
加('B1 ★ 长注入（>80 字）能剥掉，只剩真话', r.tip, '你说的那个梗我真没懂')
加('B2 不含「关于他」', r.tip.includes('关于他'), false)

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '（关于他：称呼：主人）[10:00] 早\n[10:05] 我起来了' }] })
加('B3 多个 [HH:MM] → 取最后一个之后', r.tip, '我起来了')

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '（笑）你这人真有意思' }] })
加('B4 ★「（笑）」不能被剥掉', r.tip, '（笑）你这人真有意思')

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '（小声）我不想去了' }] })
加('B5「（小声）」也不能剥', r.tip, '（小声）我不想去了')

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '今天天气不错' }] })
加('B6 干净短句原样', r.tip, '今天天气不错')

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '[00:21] 在吗' }] })
加('B7 只有时间标记 → 剥掉标记', r.tip, '在吗')

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '[00:21]' }] })
加('B8 只有标记没有正文 → 不会变空', r.tip.length > 0, true)

r = 摘要({ model: 'x', messages: [{ role: 'user', content: '（系统提示：不要回复）真的别回' }] })
加('B9 含「系统」的括号块照样剥', r.tip, '真的别回')

// ── 脏数据 ──
加('C1 空对象不崩', 摘要({}).kind, '对话')
加('C2 null 不崩', 摘要(null).tip, '')
加('C3 messages 不是数组', 摘要({ messages: 'x' }).tip, '')
r = 摘要({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: '数组形式的用户消息' }] }] })
加('C4 用户消息是数组块 → 取出 text', r.tip, '数组形式的用户消息')

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (实 === 期) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const x of 败) console.log('  ★ ' + x)
console.log('\n两个真实形状的摘要：')
console.log('  工具回填 → ' + 摘要(工具请求([{ type: 'text', text: '划走了。这次' }])).tip)
console.log('  对话     → ' + 摘要({ model: 'x', messages: [{ role: 'user', content: '（关于他：称呼：主人；记得：2026-11-13 教训：发照片前先看一眼文件的日期）[00:21] 这个梗我说了好几遍了' }] }).tip)
