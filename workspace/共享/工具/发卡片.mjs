// 发卡片.mjs —— 发一条 QQ 卡片（分享卡）出去（2026-11-07，主人要求「你补一个发卡片消息」）
// 用法：
//   node 发卡片.mjs --给 {{OWNER_UIN}} --标题 "标题" --摘要 "一句话" --链接 https://... [--图 https://...] [--来源 哔哩哔哩]
//   node 发卡片.mjs --群 1051483012 --标题 ... --链接 ...
// 只发这一条，不碰别的；发完打印回执里的 message_id。
import { 载配置, 发私聊, 发群 } from './发送口.mjs'

const args = process.argv.slice(2)
const val = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? String(args[i + 1] ?? d) : d }
const 给 = val('给')
const 群 = val('群')
const 标题 = val('标题')
const 摘要 = val('摘要')
const 链接 = val('链接')
const 图 = val('图')
const 来源 = val('来源', '哔哩哔哩')

if (!标题 || !链接) { console.error('至少要 --标题 和 --链接'); process.exit(1) }
if (!给 && !群) { console.error('要 --给 <QQ号> 或 --群 <群号>'); process.exit(1) }

// 批次608：走统一发送口（目标白名单 + 内容审计 + 代理动作日志）
const c = 载配置()

// 结构卡 2026-11-07：上一版只填了 title/desc/jumpUrl，手机上显示「发送者版本过低」——
// 少了 config / extra / appid / preview 这几段，客户端认不出来。这次按完整的 news 版式填。
const 秒 = Math.floor(Date.now() / 1000)
const 卡 = {
  app: "com.tencent.structmsg",
  config: { autosize: true, ctime: 秒, forward: true, type: "news" },
  desc: 来源,
  extra: { app_type: 1, appid: 1, uin: 0 },
  meta: {
    news: {
      actionData: "",
      actionData_A: "",
      android_pkg_name: "",
      app_type: 1,
      appid: 100951776,
      ctime: 秒,
      desc: 摘要 || 标题,
      jumpUrl: 链接,
      preview: 图 || "https://i0.hdslb.com/bfs/archive/cdd8d2fabb557d2e247c5950e374966b795feb0b.jpg",
      source_icon: "",
      tag: 来源,
      title: 标题,
    },
  },
  prompt: "[" + 来源 + "] " + 标题,
  ver: "0.0.0.1",
  view: "news",
}

const 消息 = [{ type: 'json', data: { data: JSON.stringify(卡) } }]
const r = 群 ? await 发群(c, 群, 消息) : await 发私聊(c, 给, 消息)
if (r.ok) console.log('发出去了，message_id=' + (r.msgId ?? '?'))
else { console.log('没发成：' + r.err); process.exit(2) }
