// /api/doc 的真实 HTTP 测试。用面板自己的密钥签一个 owner cookie。
// 所有写请求都走「拒绝路径」或「内容未变」分支——不改变任何真实文件。
//
// PANEL_REQUIRED 2026-11-24：这个文件要真连 127.0.0.1:8788 的面板。
// 而面板在部分主机上是**刻意停用**的（角色=scripts），于是整份测试 ECONNREFUSED
// → 全套跑出 1 个红。现在先探端口：没在听就整份跳过（exit 0，打一行说明），
// 不让「本机不装面板」变成测试失败。
import fs from 'node:fs'
import crypto from 'node:crypto'

function 端口在听(p) {
  const hex = Number(p).toString(16).toUpperCase().padStart(4, '0')
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const txt = String(fs.readFileSync(f, 'utf8'))
      for (const line of txt.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 4) continue
        if ((c[1] || '').endsWith(':' + hex) && c[3] === '0A') return true
      }
    } catch { /* 读不到就跳过 */ }
  }
  return false
}
const 面板口 = Number(process.env.PANEL_PORT || 8788)
if (!端口在听(面板口)) {
  console.log('（面板 :' + 面板口 + ' 未在本机运行，t401 整份跳过）')
  process.exit(0)
}

const 密 = JSON.parse(fs.readFileSync('/data/bot-workspace/共享/工具/面板密钥.json', 'utf8'))
const body = Buffer.from(JSON.stringify({ role: 'owner', u: 'selftest', exp: Date.now() + 3600e3 })).toString('base64url')
const token = body + '.' + crypto.createHmac('sha256', 密.secret).update(body).digest('base64url')

const 基 = 'http://127.0.0.1:8788'
const 头 = { cookie: 'fish_session=' + encodeURIComponent(token), 'content-type': 'application/json' }

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])

const get = async (f) => {
  const r = await fetch(基 + '/api/doc?f=' + encodeURIComponent(f), { headers: 头 })
  return r.json()
}
const post = async (o) => {
  const r = await fetch(基 + '/api/doc', { method: 'POST', headers: 头, body: JSON.stringify(o) })
  return r.json()
}

// ── 读 ──
const soul = await get('SOUL')
加('A1 读 SOUL 成功', soul.ok, true)
加('A2 SOUL 里有「{{ALT_BOT_DISPLAY}}」', String(soul.内容 || '').includes('{{ALT_BOT_DISPLAY}}'), true)
加('A3 读到了字节数和改于', typeof soul.字节 === 'number' && /\d{4}-\d{2}-\d{2}/.test(soul.mtime), true)
加('A4 类 是 md', soul.类, 'md')
加('A5 带上限和备份数', typeof soul.上限 === 'number' && typeof soul.备份数 === 'number', true)

const 人味 = await get('人味')
加('B1 读 人味 成功', 人味.ok, true)
加('B2 人味的类是 json', 人味.类, 'json')
加('B3 人味能 JSON.parse', (() => { try { JSON.parse(人味.内容); return true } catch { return false } })(), true)

const 坏 = await get('不存在的文档')
加('C1 未知 key → 报错', 坏.ok, false)
加('C2 报错带说明', String(坏.msg || '').includes('没有这份文档'), true)

const 空 = await get('')
加('C3 空 key → 报错', 空.ok, false)

// ── 写：全部拒绝路径 ──
const w1 = await post({ f: '不存在的文档', 内容: 'x' })
加('D1 写未知 key → 拒', w1.ok, false)

const w2 = await post({ f: 'SOUL', 内容: '' })
加('D2 空内容 → 拒（不能把她人格清空）', w2.ok, false)
加('D3 空内容的报错说明', String(w2.msg || '').includes('不能清空'), true)

const w3 = await post({ f: 'SOUL', 内容: '   \n  \n ' })
加('D4 只有空白 → 拒', w3.ok, false)

const w4 = await post({ f: '人味', 内容: '{这不是 JSON' })
加('D5 人味传坏 JSON → 拒', w4.ok, false)
加('D6 报错说明提到 JSON', String(w4.msg || '').includes('JSON'), true)

const w5 = await post({ f: 'SOUL', 内容: 'x'.repeat(65537) })
加('D7 超 64KB → 拒', w5.ok, false)
加('D8 报错说明提到太长', String(w5.msg || '').includes('太长'), true)

// ── 写：内容未变（不落盘）──
const 原样 = soul.内容
const w6 = await post({ f: 'SOUL', 内容: 原样 })
加('E1 原样保存 → ok', w6.ok, true)
加('E2 ★ 走的是「一个字都没改」分支（没写盘）', w6.未变, true)

// ── 权限：没 cookie ──
const r7 = await fetch(基 + '/api/doc?f=SOUL')
const j7 = await r7.json()
// 没 cookie 时是**统一闸**在更前面拦的（批次349 那套），返回 {error:'未登录'} —— 比本接口自己拒更早。
加('F1 没 cookie → 拒（统一闸先拦）', j7.ok !== true, true)
加('F2 没 cookie 给了「未登录」', String(j7.error || j7.msg || '').length > 0, true)

// ── 确认真实文件没被改 ──
const 后 = fs.readFileSync('/data/bot-workspace/SOUL.md', 'utf8')
加('G1 ★ 测完 SOUL.md 一字未变', 后 === 原样, true)
const 备 = (() => { try { return fs.readdirSync('/data/bot-workspace/记忆/.文档备份').filter((f) => f.startsWith('SOUL-')).length } catch { return 0 } })()
加('G2 没有多出备份（说明真的没写）', 备, 0)

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (实 === 期) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const x of 败) console.log('  ★ ' + x)
