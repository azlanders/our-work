#!/usr/bin/env node
/**
 * 读卡片.js —— 群里收到「卡片消息」时直接跑这个，别再靠想起来。
 *
 * 用法：
 *   node 工具/读卡片.js            看本群最近 5 条里的卡片、链接和文件
 *   node 工具/读卡片.js -n 10      看最近 10 条
 *   node 工具/读卡片.js -g 2000000002  指定群
 *
 * 为什么单独做成脚本：2026-10-31 踩过——卡片正文（比如 B 站小程序的 qqdocurl）
 * 其实在 message 的 json 段里，拉整条原始消息就能扒出来，可当时第一反应是「读不到」。
 * 做成命令，下次遇到直接跑，不用先想起来「咦是不是有个办法」。
 *
 * 调用层统一走 ./lib/onebot.js（它负责读配置，以及 3001 假成功时自动退 3000）。
 */
const { call, defaultGroup, knownGroup } = require('./lib/onebot.js');

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const count = Number(opt('-n', '5')) || 5;
const groupId = opt('-g', defaultGroup());

if (!groupId) {
  console.error('配置里没有群路由，不知道拉哪个群');
  process.exit(1);
}
if (!knownGroup(groupId)) {
  console.error(`群 ${groupId} 不在配置里（routes.group / groupUins），不拉`);
  process.exit(1);
}

// 从卡片 json 里挖链接：递归找所有字符串里的 http(s)
function digLinks(jsonStr) {
  const out = [];
  try {
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && /https?:\/\//.test(v)) out.push(`${k}: ${v}`);
        else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(JSON.parse(jsonStr));
  } catch { /* 不是标准 json 就算了 */ }
  return out;
}

(async () => {
  // HTTP 的 schema 要 string（批次407 实测：传 Number 直接 400 Expected string）。
  const r = await call('get_group_msg_history', { group_id: String(groupId), count });
  const msgs = (r && r.data && r.data.messages) || [];
  if (msgs.length === 0) {
    console.log('没拉到消息（看看是不是 3001 代理又假成功了，或群号不对）');
    return;
  }

  // 2026-10-31 加：reply 段只有被引用消息的 id，没有原文。
  // 现在遇到 reply 就把那条原始消息拉回来，把被引用的内容补在下面——
  // 不然只能看到「[reply] {id:...}」，等于看不见引用。
  async function quotedOf(msg) {
    const seg = (msg.message || []).find((x) => x.type === 'reply');
    const id = seg && seg.data && seg.data.id;
    if (!id) return null;
    try {
      const g = await call('get_msg', { message_id: Number(id) });
      const d = (g && g.data) || {};
      const t = (d.message || []).map((x) => (x.type === 'text' ? (x.data.text || '')
        : x.type === 'image' ? '[图片]' : x.type === 'at' ? '@' + (x.data.qq || '') : '')).join('').trim();
      const who = (d.sender || {}).nickname || d.user_id || '';
      return `${who}: ${t}`.slice(0, 200);
    } catch { return '(拉不到被引用的那条)'; }
  }

  for (const m of msgs) {
    const who = (m.sender && (m.sender.nickname || m.sender.card)) || m.user_id;
    const time = new Date((m.time || 0) * 1000)
      .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const segs = m.message || [];
    const kinds = segs.map((s) => s.type).join(',') || '空';
    const quoted = await quotedOf(m);
    console.log(`\n=== ${time} ${who} [${kinds}]`);
    if (quoted) console.log('  ↪ 被引用:', quoted);

    for (const s of segs) {
      const d = s.data || {};
      if (s.type === 'text') {
        const t = String(d.text || '').trim();
        if (t) console.log('  文字:', t.slice(0, 80));
      } else if (s.type === 'json') {
        const raw = String(d.data || '');
        console.log('  卡片 json:', raw.slice(0, 200), raw.length > 200 ? '…' : '');
        for (const line of digLinks(raw)) console.log('    ↳', line.slice(0, 160));
      } else if (s.type === 'file') {
        console.log('  文件:', d.file || '', d.file_size || '');
      } else if (s.type === 'image') {
        console.log('  图片:', String(d.file || '').slice(0, 60));
      } else {
        if (s.type === 'reply') {
          console.log('  [reply] id=' + (d.id || '?'));
          continue;  // 下面统一补被引用原文
        }
        console.log(`  [${s.type}]`, JSON.stringify(d).slice(0, 120));
      }
    }
  }
})();
