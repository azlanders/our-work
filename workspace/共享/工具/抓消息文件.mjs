import { 原子写 } from './_底层.mjs'
// 抓消息文件.mjs —— 把群里某条消息带回来的视频/文件真弄到手（2026-11-06，主人要求）
// 用法：node 抓消息文件.mjs <message_id> [输出目录]
// 只下、不解、不发言；下到 {{BOT_ROOT}}/下载/<id>-<序号>.<后缀>
import fs from 'node:fs'
import path from 'node:path'

const id = process.argv[2]
const 出目录 = process.argv[3] || '{{BOT_ROOT}}/下载'
if (!id) { console.error('要一个消息编号'); process.exit(1) }

const c = JSON.parse(fs.readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
const base = String(c.onebotHttp || '').replace(/:3001/, ':3000').replace(/\/$/, '')
const H = { 'Content-Type': 'application/json', ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}) }

const r = await fetch(base + '/get_msg', { method: 'POST', headers: H, body: JSON.stringify({ message_id: Number(id) }) })
const j = await r.json()
const segs = j?.data?.message || []
const 要下 = segs.filter((s) => ['video', 'file', 'record'].includes(String(s?.type)))
if (!要下.length) { console.log('这条里没有视频或文件'); process.exit(0) }
fs.mkdirSync(出目录, { recursive: true })
let n = 0
for (const s of 要下) {
  const u = s?.data?.url || s?.data?.file
  if (!u || !/^https?:/.test(String(u)) && !/^\/\//.test(String(u))) { console.log('这条没给可下的地址'); continue }
  const url = String(u).startsWith('//') ? 'https:' + u : String(u)
  const 后缀 = (String(s?.data?.file || '').match(/\.\w{2,4}$/) || ['.mp4'])[0]
  const 目标 = path.join(出目录, `${id}-${++n}${后缀}`)
  const res = await fetch(url)
  if (!res.ok) { console.log('下失败', res.status); continue }
  原子写(目标, Buffer.from(await res.arrayBuffer()))
  console.log('下好了 →', 目标, Math.round(fs.statSync(目标).size / 1024) + 'KB')
}
