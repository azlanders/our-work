#!/usr/bin/env node
import { 原子写 } from './_底层.mjs'
/**
 * 网盘.mjs —— 阿里云 PDS（网盘与相册服务）命令行工具（2026-11-14 批次478）
 *
 * 为什么是 PDS 而不是「随便一个网盘」：主人给的 `bj42060.apps.aliyunfile.com` 就是 PDS 专属实例。
 *
 * 这个 domain 的认证只有一条路（实测）：
 *   · `/v2/account/token` 传 `grant_type: client_credentials` → 报 InvalidParameterMissing.RefreshToken
 *   · `/v2/oauth/authorize` → 403 `domain not support oauth`（官方明确不支持授权码流）
 *   · 没有 WebDAV（/webdav /dav 全 404）
 *   → **只能用 refresh_token**，而它只在登录响应里，所以必须先由人在浏览器里取一次。
 *
 * 用法：
 *   node 网盘.mjs --check                 刷新 token，打印有效期（自检用）
 *   node 网盘.mjs --ls [parent_file_id]    列目录（默认 root）
 *   node 网盘.mjs --mkdir <名字>           在 root 下建目录
 *   node 网盘.mjs --put <本地路径> [目录]   上传（>4MB 自动分片）
 *   node 网盘.mjs --du                     统计远端根目录下各目录占用
 *
 * 环境变量（写在 /etc/dshbot.env，root 600）：
 *   PDS_REFRESH_TOKEN   必填。人从浏览器登录态里取一次，工具会自动续期。
 *   PDS_DOMAIN          默认 bj42060
 *   PDS_DRIVE_ID        默认 2（来自 localStorage 的 root_group_drive_id_bj42060）
 *
 * ⚠️ 这个文件里**不许打印 token**。日志只写「刷新成功 / 剩余 N 秒」。
 */
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { basename, resolve, join } from 'node:path'

const 域 = process.env.PDS_DOMAIN || 'bj42060'
const 盘 = String(process.env.PDS_DRIVE_ID || '2')
const API = `https://${域}.api.aliyunfile.com`
const 分片大小 = 4 * 1024 * 1024

/** 读 /etc/dshbot.env（项目里其它脚本也是这么拿密钥的），不引额外依赖。 */
function 读环境() {
  const out = { ...process.env }
  try {
    for (const line of readFileSync('/etc/dshbot.env', 'utf8').split('\n')) {
      const s = line.trim()
      if (s === '' || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i <= 0) continue
      const k = s.slice(0, i).trim()
      let v = s.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (out[k] === undefined || out[k] === '') out[k] = v
    }
  } catch { /* 读不到就只用 process.env */ }
  return out
}
const ENV = 读环境()
const 刷新令牌 = String(ENV.PDS_REFRESH_TOKEN || process.env.PDS_REFRESH_TOKEN || '').trim()
// ACCESS_ONLY 2026-11-14（实测）：这个 domain 关了 OAuth（`domain not support oauth`），
// 登录走阿里云 SSO，refresh_token 拿不到 —— 只能用浏览器 Network 里抓的 access_token（约 2 小时）。
// 它是**短期**方案：够跑一次全量同步；长期要么每天换一次，要么等有人在 PDS 控制台把 OAuth 打开。
const 直连令牌 = String(ENV.PDS_ACCESS_TOKEN || process.env.PDS_ACCESS_TOKEN || '').trim()

let 当前 = { token: '', 到期: 0 }

// TOKEN_CACHE 2026-11-14（实测旧 refresh_token 仍有效，说明多个可并存）：
// 每次进程启动都刷一次太浪费 —— 心跳一天能跑几十遍。缓存到文件，2 小时内复用。
const 缓存文件 = process.env.PDS_TOKEN_CACHE || '/var/lib/pds-token.json'

function 读缓存() {
  try {
    const j = JSON.parse(readFileSync(缓存文件, 'utf8'))
    if (j && j.token && Number(j.到期) > Date.now() + 120e3) return { token: String(j.token), 到期: Number(j.到期) }
  } catch { /* 没缓存或坏了就走刷新 */ }
  return null
}

function 写缓存(t, 到期) {
  try { 原子写(缓存文件, JSON.stringify({ token: t, 到期 }), { mode: 0o600 }) } catch { /* 写不了不影响主流程 */ }
}

/** 把新令牌写回 /etc/dshbot.env（600）。PDS 每次刷新会换新的 refresh_token，旧的立刻失效。 */
function 写回env(键, 值) {
  try {
    const p = '/etc/dshbot.env'
    let s = readFileSync(p, 'utf8')
    const 行 = `${键}=${值}`
    const re = new RegExp('^' + 键 + '=.*$', 'm')
    s = re.test(s) ? s.replace(re, 行) : s.replace(/\n*$/, '') + '\n' + 行 + '\n'
    原子写(p, s, { mode: 0o600 })
    console.log(`[token] ${键} 已轮换回写`)
  } catch (e) {
    console.error(`[token] 回写 ${键} 失败（下次要用旧令牌了）：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function 取令牌(强刷 = false) {
  if (!强刷) {
    if (当前.token !== '' && Date.now() < 当前.到期 - 60e3) return 当前.token
    const c = 读缓存()
    if (c) { 当前 = c; return c.token }
  }
  if (刷新令牌 === '') {
    if (直连令牌 !== '') return 直连令牌
    throw new Error('既没有 PDS_REFRESH_TOKEN 也没有 PDS_ACCESS_TOKEN。先让人从浏览器 Network 里抓一次')
  }
  const r = await fetch(`${API}/v2/account/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 刷新令牌 })
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* 下面统一报 */ }
  if (!r.ok || !j || !j.access_token) {
    throw new Error(`刷新令牌失败 HTTP ${r.status}: ${t.slice(0, 300)}`)
  }
  当前 = { token: j.access_token, 到期: Date.now() + (Number(j.expires_in) || 7200) * 1000 }
  写缓存(当前.token, 当前.到期)
  // ROTATE：PDS 每次刷新都会返回**新的** refresh_token，旧的立刻作废。
  // 不回写的话，这个进程能用，但下次启动就拿废弃的旧令牌去刷 = 401。
  if (j.refresh_token && String(j.refresh_token) !== 刷新令牌) 写回env('PDS_REFRESH_TOKEN', String(j.refresh_token))
  // 只报有效期，绝不打印 token 本身
  console.log(`[token] 刷新成功，有效期 ${Math.round((Number(j.expires_in) || 7200) / 60)} 分钟`)
  return 当前.token
}

async function 调(路径, 体) {
  const token = await 取令牌()
  const r = await fetch(`${API}${路径}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(体)
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* 保留原文 */ }
  if (!r.ok) {
    throw new Error(`${路径} HTTP ${r.status}: ${(j && (j.code + ' ' + j.message)) || t.slice(0, 300)}`)
  }
  return j
}

async function 列目录(parent = 'root', 累积 = [], 页 = '') {
  const 体 = { drive_id: 盘, parent_file_id: parent, limit: 100, order_by: 'name', order_direction: 'ASC' }
  if (页 !== '') 体.marker = 页
  const j = await 调('/v2/file/list', 体)
  const items = Array.isArray(j?.items) ? j.items : []
  累积.push(...items)
  if (j?.next_marker) return 列目录(parent, 累积, String(j.next_marker))
  return 累积
}

async function 建目录(名字, parent = 'root', 复用 = false) {
  try {
    const j = await 调('/v2/file/create', {
      drive_id: 盘, parent_file_id: parent, name: 名字, type: 'folder',
      check_name_mode: 'refuse'
    })
    console.log(`[mkdir] ${名字} -> ${j.file_id}`)
    return j.file_id
  } catch (e) {
    if (!复用) throw e
    // 递归传目录时目录可能已经建过 —— 去列表里找同名的复用，别再造一个
    const items = await 列目录(parent)
    const hit = items.find((it) => it.type === 'folder' && it.name === 名字)
    if (hit) { console.log(`[mkdir] ${名字} 已存在，复用`); return hit.file_id }
    throw e
  }
}

async function 上传(本地, parent = 'root') {
  const 绝对 = resolve(本地)
  const st = statSync(绝对)
  const 名 = basename(绝对)
  const 片数 = Math.max(1, Math.ceil(st.size / 分片大小))
  const 体 = {
    drive_id: 盘, parent_file_id: parent, name: 名, type: 'file', size: st.size,
    check_name_mode: 'auto_rename',
    part_info_list: Array.from({ length: 片数 }, (_, i) => ({ part_number: i + 1 }))
  }
  const 建 = await 调('/v2/file/create', 体)
  if (process.env.PDS_DEBUG === '1') console.log('[debug] create ->', JSON.stringify(建).slice(0, 2000))
  const urls = Array.isArray(建?.part_info_list) ? 建.part_info_list : []
  if (建?.rapid_upload === true) { console.log(`[put] ${名} 秒传命中`); return }
  if (urls.length !== 片数) throw new Error(`分片 URL 数量不对：要 ${片数}，回 ${urls.length}`)

  // 逐个分片 PUT（PDS 给的是 OSS 预签名 URL，不带 Authorization）
  // PART_STREAM 2026-11-14：原来每片都 readFileSync 整个文件 —— 531M 的 mp4 要读 133 遍。
  // 改成 open 一次 + readSync 按偏移读，内存峰值只有一个分片。
  // ETAG 也必须从 PUT 响应头取：create 响应里的 etag 是空的，complete 会因此失败。
  const fd = openSync(绝对, 'r')
  const 已传 = []
  try {
    for (const p of urls) {
      const start = (p.part_number - 1) * 分片大小
      const len = Math.min(分片大小, st.size - start)
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, start)
      const r = await fetch(p.upload_url, { method: 'PUT', body: buf })
      if (!r.ok) throw new Error(`第 ${p.part_number} 片上传失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
      // ETAG_DROP 2026-11-14（实测）：PDS 的 complete **不认** OSS 返回的 ETag ——
      // 传了会报 `part 1 Etag '...' is not matched with serverside`。
      // create 的 part_info_list 里也只有 part_number，没有 etag。所以只传 part_number。
      已传.push({ part_number: p.part_number })
    }
  } finally { closeSync(fd) }
  await 调('/v2/file/complete', {
    drive_id: 盘, file_id: 建.file_id, upload_id: 建.upload_id, part_info_list: 已传
  })
  console.log(`[put] ${名} 完成（${(st.size / 1048576).toFixed(1)}M / ${片数} 片）`)
}

async function 列盘() {
  // DRIVE_ID_真源：drive_id 不许靠猜。PDS 的盘分两种 ——
  //   list_my_drives        个人盘
  //   list_my_group_drive   团队盘（这个账号「未分配个人空间」，文件在团队盘里）
  // 2026-11-14：从主人浏览器 Network 列表里拿到这两个真实路径，替换掉原先按
  // localStorage 的 root_group_drive_id 猜 "2" 的做法。
  for (const p of ['/v2/drive/list_my_drives', '/v2/drive/list_my_group_drive']) {
    try {
      const j = await 调(p, { limit: 100 })
      const items = Array.isArray(j?.items) ? j.items : []
      // 根团队盘不在 items 里，单独一个 root_group_drive 字段 —— 不打印它就看不出配额改没改
      const r = j?.root_group_drive
      if (r) {
        console.log(`  [根团队盘] drive_id=${r.drive_id} name=${r.drive_name || '?'} 已用 ${((Number(r.used_size) || 0) / 1073741824).toFixed(2)}G / 总 ${((Number(r.total_size) || 0) / 1073741824).toFixed(2)}G`)
      }
      console.log(`--- ${p}（items ${items.length}）---`)
      for (const d of items) {
        const 用 = Number(d.used_size) || 0
        const 总 = Number(d.total_size) || 0
        console.log(`  drive_id=${d.drive_id}  name=${d.drive_name || '?'}  已用 ${(用 / 1048576).toFixed(1)}M / ${(总 / 1073741824).toFixed(2)}G`)
      }
    } catch (e) {
      console.log(`${p} 失败：${e instanceof Error ? e.message.slice(0, 140) : String(e)}`)
    }
  }
}

/**
 * 整个目录搬上去（只传文件，不递归子目录）。
 * 一个进程里循环，省掉「每个文件起一次 node」的开销。
 * 单个文件失败只记账，不停整批 —— 1.33G 传一半因为一个坏文件全废掉是不可接受的。
 */
async function 传目录(本地目录, parentId, 后缀 = '') {
  const 全 = readdirSync(本地目录)
  const 文件 = [], 子 = []
  for (const f of 全) {
    try {
      const st = statSync(join(本地目录, f))
      if (st.isDirectory()) 子.push(f)
      else if (st.isFile()) 文件.push(f)
    } catch { /* 读不了就跳过 */ }
  }
  // 远端已有的按名字跳过 —— 重跑不会造出 xxx(1).mp4
  let 已有 = new Set()
  try {
    已有 = new Set((await 列目录(parentId)).filter((x) => x.type === 'file').map((x) => x.name))
  } catch { /* 列不了就当全都没有 */ }
  const 候选 = 后缀 === '' ? 文件 : 文件.filter((f) => f.toLowerCase().endsWith(后缀.toLowerCase()))
  const 选 = 候选.filter((f) => !已有.has(f)).sort()
  const 跳过 = 候选.length - 选.length
  console.log(`[putdir] ${本地目录}：待传 ${选.length}${跳过 ? '，跳过已有 ' + 跳过 : ''}（子目录 ${子.length}）`)
  let ok = 0, fail = 0, 字节 = 0
  const 失败 = []
  for (const f of 选) {
    const p = join(本地目录, f)
    try {
      const sz = statSync(p).size
      await 上传(p, parentId)
      ok++; 字节 += sz
    } catch (e) {
      fail++
      失败.push(f + ' — ' + (e instanceof Error ? e.message.slice(0, 120) : String(e)))
    }
  }
  if (失败.length) {
    console.log(`[putdir] 失败 ${fail} 个：`)
    for (const x of 失败.slice(0, 20)) console.log('  ✗ ' + x)
  }
  // 再递归子目录（建同名目录，已存在就复用）
  for (const d of 子.sort()) {
    const id = await 建目录(d, parentId, true)
    await 传目录(join(本地目录, d), id, 后缀)
  }
  if (ok > 0 || 失败.length > 0) console.log(`[putdir] 本层完成 ok=${ok} fail=${fail} 共 ${(字节 / 1048576).toFixed(1)}M`)
}

/**
 * 下载一个文件到本地 —— 只为了「往返验证」。
 * 传上去了不等于拿得回来；真要删本地之前必须先跑一遍 md5 对得上。
 */
async function 下载(fileId, 输出) {
  const j = await 调('/v2/file/get_download_url', { drive_id: 盘, file_id: fileId, expire_sec: 900 })
  const url = j?.url || j?.crc64_hash && j?.url
  if (!url) throw new Error('没拿到下载 URL：' + JSON.stringify(j).slice(0, 200))
  const r = await fetch(url)
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  原子写(输出, buf)
  console.log(`[get] ${输出}  ${(buf.length / 1048576).toFixed(2)}M`)
  return j
}

async function 删除(fileId, 静默 = false) {
  // PDS 的 delete 只对**回收站里**的文件生效（实测报 FileNotInRecycleBinCannotBeDelete），
  // 所以「彻底删」= 先 trash 再 delete 两步。只调 delete 一定失败。
  // TRASH_PATH 2026-11-14（批次486）：trash 的正确前缀是 **/v2/recyclebin/trash**，
  // 批次478 记的「/v2/file/trash 是 404、路径未找到」到此为止 —— 拿假 file_id 试，
  // /v2/file/trash 回 404 空体，/v2/recyclebin/trash 回 `NotFound.FileId`（说明路径对）。
  await 调('/v2/recyclebin/trash', { drive_id: 盘, file_id: fileId })
  const j = await 调('/v2/file/delete', { drive_id: 盘, file_id: fileId })
  if (!静默) console.log(`[rm] ${fileId} -> ${j?.async_task_id ? '异步任务 ' + j.async_task_id : 'ok'}`)
}

/**
 * FORCE_PUT 2026-11-14（批次486）：PDS 没有 overwrite 模式（`check_name_mode` 只有
 * ignore / auto_rename / refuse / check_name_and_hash），所以「用新内容替换同名文件」
 * 只能先删旧份再传新的。不这么做的话，`auto_rename` 会造出「内心(1).md」「内心(2).md」，
 * 越滚越多，而且远端读到的还是第一份旧的。
 */
async function 覆盖上传(本地, parent = 'root') {
  const 名 = basename(resolve(本地))
  let 删了 = 0
  try {
    const 列 = await 列目录(parent)
    for (const x of 列) {
      if (String(x.name) === 名) { await 删除(x.file_id, true); 删了++ }
    }
  } catch (e) {
    console.log(`[force] 列目录失败，按新增处理：${e instanceof Error ? e.message.slice(0, 80) : e}`)
  }
  await 上传(本地, parent)
  console.log(`[force] ${名} 覆盖完成（删掉旧的 ${删了} 份）`)
}

/**
 * TREE_SYNC 2026-11-14（批次486）：把本地一棵树同步到远端目录。
 * 和 `--putdir` 的区别：**同名同大小就跳过，不同就删旧传新**。
 * `--putdir` 只按文件名跳过，所以「内心.md」这种固定文件名、内容会变的文件永远传不上去，
 * 而 `auto_rename` 又会造出一堆「内心(1).md」。
 */
async function 树同步(本地目录, parentId, 层级 = 0) {
  const 项 = readdirSync(本地目录, { withFileTypes: true })
  const 远端 = await 列目录(parentId)
  const 远文件 = new Map(远端.filter((x) => x.type !== 'folder').map((x) => [String(x.name), x]))
  const 远目录 = new Map(远端.filter((x) => x.type === 'folder').map((x) => [String(x.name), x.file_id]))
  const 缩 = '  '.repeat(层级)
  let 新传 = 0, 覆盖 = 0, 跳过 = 0, 失败 = 0, 字节 = 0
  for (const e of 项) {
    const p = join(本地目录, e.name)
    if (e.isDirectory()) {
      let 子 = 远目录.get(e.name)
      if (!子) 子 = await 建目录(e.name, parentId, true) // 复用：同名目录已存在就别再建
      const r = await 树同步(p, 子, 层级 + 1)
      新传 += r.新传; 覆盖 += r.覆盖; 跳过 += r.跳过; 失败 += r.失败; 字节 += r.字节
      continue
    }
    try {
      const st = statSync(p)
      const 旧 = 远文件.get(e.name)
      if (旧 && Number(旧.size) === st.size) { 跳过++; continue }
      if (旧) { await 删除(旧.file_id, true); 覆盖++ } else { 新传++ }
      await 上传(p, parentId)
      字节 += st.size
    } catch (err) {
      失败++
      console.log(`${缩}✗ ${e.name} — ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`)
    }
  }
  if (层级 === 0) console.log(`[sync] 新传 ${新传} / 覆盖 ${覆盖} / 跳过 ${跳过} / 失败 ${失败} / ${(字节 / 1048576).toFixed(2)}M`)
  return { 新传, 覆盖, 跳过, 失败, 字节 }
}

async function 统计(parent = 'root', 前缀 = '') {
  const items = await 列目录(parent)
  let 文件 = 0, 体积 = 0, 目录 = 0
  for (const it of items) {
    if (it.type === 'folder') { 目录++; continue }
    文件++; 体积 += Number(it.size) || 0
  }
  console.log(`${(前缀 || '/').padEnd(28)} 文件 ${String(文件).padStart(5)}  ${(体积 / 1048576).toFixed(1)}M  (子目录 ${目录})`)
  for (const it of items.filter((x) => x.type === 'folder')) {
    try { await 统计(it.file_id, (前缀 || '') + '/' + it.name) } catch (e) { console.log(`  (${it.name} 读不了: ${e.message.slice(0, 60)})`) }
  }
}

const argv = process.argv.slice(2)
const 命令 = argv[0] || '--help'
try {
  if (命令 === '--check') {
    // 不强制刷新：命中文件缓存就直接报「可用」。
    // 每次 --check 都强刷会白白轮换一次 refresh_token（PDS 会发新的），没有意义。
    await 取令牌()
    const 剩 = 当前.到期 > 0 ? Math.round((当前.到期 - Date.now()) / 60000) + ' 分钟' : '未知（直连令牌）'
    console.log(`[check] token 可用，剩余 ${剩}；drive_id=${盘} domain=${域}`)
  } else if (命令 === '--ls') {
    const items = await 列目录(argv[1] || 'root')
    for (const it of items) {
      const 型 = it.type === 'folder' ? 'D' : 'F'
      const 大小 = it.type === 'folder' ? '-' : (Number(it.size) / 1048576).toFixed(1) + 'M'
      // file_id 要打出来 —— 下一步 --put / --ls 都靠它当 parent_file_id
      console.log(`${型}  ${大小.padStart(8)}  ${it.file_id}  ${it.name}`)
    }
    console.log(`--- 共 ${items.length} 项`)
  } else if (命令 === '--mkdir') {
    if (!argv[1]) throw new Error('要目录名')
    await 建目录(argv[1], argv[2] || 'root')
  } else if (命令 === '--put') {
    if (!argv[1]) throw new Error('要本地路径')
    await 上传(argv[1], argv[2] || 'root')
  } else if (命令 === '--du') {
    await 统计()
  } else if (命令 === '--drives' || 命令 === '--whoami') {
    await 列盘()
  } else if (命令 === '--putdir') {
    if (!argv[1] || !argv[2]) throw new Error('用法：--putdir <本地目录> <远端parent_file_id> [后缀]')
    await 传目录(argv[1], argv[2], argv[3] || '')
  } else if (命令 === '--tree-sync') {
    if (!argv[1] || !argv[2]) throw new Error('用法：--tree-sync <本地目录> <远端parent_file_id>')
    await 树同步(argv[1], argv[2])
  } else if (命令 === '--put-force') {
    if (!argv[1]) throw new Error('用法：--put-force <本地文件> [远端parent_file_id]')
    await 覆盖上传(argv[1], argv[2] || 'root')
  } else if (命令 === '--get') {
    if (!argv[1] || !argv[2]) throw new Error('用法：--get <file_id> <本地输出路径>')
    await 下载(argv[1], argv[2])
  } else if (命令 === '--rm') {
    if (!argv[1]) throw new Error('用法：--rm <file_id>')
    await 删除(argv[1])
  } else {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 26).join('\n'))
  }
} catch (e) {
  console.error('[失败] ' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
