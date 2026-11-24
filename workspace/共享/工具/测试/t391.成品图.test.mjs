// 成品图·是成品图。一条正则，但六处扫描共用 —— 判宽了照片墙上会混进截图，
// 判严了她的真实照片会消失（老照片没有 sidecar json，不能拿 json 当判据）。
import fs from 'node:fs'

const { 是成品图, 成品目录 } = await import('{{BOT_ROOT}}/共享/工具/成品图.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])

// ── 应该认的 ──
加('典型 id（8 位）', 是成品图('m3k9x2ab.png'), true)
加('正好 6 位', 是成品图('abcdef.png'), true)
加('纯数字 6 位', 是成品图('123456.png'), true)
加('正好 32 位', 是成品图('a'.repeat(32) + '.png'), true)
加('数字字母混合', 是成品图('a1b2c3d4.png'), true)
加('全数字 32 位', 是成品图('1'.repeat(32) + '.png'), true)

// ── 应该拒的：长度 ──
加('5 位（太短）', 是成品图('abcde.png'), false)
加('33 位（太长）', 是成品图('a'.repeat(33) + '.png'), false)

// ── 应该拒：字符集 ──
加('★ 主人那次踩的：带中文和短横', 是成品图('身上-体温-20261107.png'), false)
加('大写字母', 是成品图('ABC123.png'), false)
加('短横', 是成品图('abc-def.png'), false)
加('下划线', 是成品图('abc_def.png'), false)
加('空格', 是成品图('abc def.png'), false)
// ★ 这条是判据的边界：zztest134 是 9 位小写字母+数字，**形状完全合规**，
//   所以它会被当成她的照片。删除.log 里记着这个文件曾经污染过照片墙。
//   判据只能挡「形状不对」的（中文/短横/大写/截图名），挡不住「形状对但内容是截图」的。
加('★ zztest134.png 形状合规 → 认（判据挡不住形状对的误存）', 是成品图('zztest134.png'), true)

// ── 应该拒：扩展名 ──
加('jpg', 是成品图('abcdef.jpg'), false)
加('大写 .PNG', 是成品图('abcdef.PNG'), false)
加('没有扩展名', 是成品图('abcdef'), false)
加('双扩展名', 是成品图('abcdef.png.png'), false)
加('webp', 是成品图('abcdef.webp'), false)

// ── 应该拒：路径与脏值 ──
加('带目录前缀', 是成品图('成品/abcdef.png'), false)
加('绝对路径', 是成品图('{{BOT_ROOT}}/共享/自拍/成品/abcdef.png'), false)
加('null', 是成品图(null), false)
加('undefined', 是成品图(undefined), false)
加('空串', 是成品图(''), false)
加('数字（不是字符串）', 是成品图(123456), false)
加('对象', 是成品图({}), false)
// String(['abcdef.png']) === 'abcdef.png'，所以单元素数组也会通过。
// 实际调用方传的都是 readdirSync 的元素（字符串），遇不到；记下来免得以后踩。
加('单元素数组会被 String() 拼成字符串 → 认', 是成品图(['abcdef.png']), true)

// ── 前后带空格：正则不 trim，所以拒 ──
加('前后有空格 → 拒（没有 trim）', 是成品图(' abcdef.png '), false)

// ── 真实目录冒烟 ──
{
  let 文件们 = []
  try { 文件们 = fs.readdirSync(成品目录) } catch { 文件们 = [] }
  const 认 = 文件们.filter((f) => 是成品图(f))
  const 拒 = 文件们.filter((f) => !是成品图(f))
  console.log(`真实成品目录：${文件们.length} 个文件，认得 ${认.length} 个，不认 ${拒.length} 个`)
  if (拒.length) console.log('  不认的：' + 拒.slice(0, 8).join('、'))
  加('真实目录里认得的比不认的多（数据正常）', 认.length >= 拒.length, true)
  // 认出来的必须都是真实存在的 png
  加('认出来的都是 .png 结尾', 认.every((f) => f.endsWith('.png')), true)
  加('认出来的总长度都在 10~36（6~32 位 id + .png）', 认.every((f) => f.length >= 10 && f.length <= 36), true)
}

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (JSON.stringify(实) === JSON.stringify(期)) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
