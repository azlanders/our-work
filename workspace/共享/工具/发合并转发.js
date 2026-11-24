#!/usr/bin/env node
/**
 * 发合并转发.js —— 把一大段内容打成 QQ「合并转发」发出去，别一屏屏刷。
 *
 * 用法：
 *   node 工具/发合并转发.js -f 文件路径            把文件内容发到默认群
 *   node 工具/发合并转发.js -t 标题 -f 文件路径     带标题
 *   node 工具/发合并转发.js -t 标题 -g 群号 -f 文件  指定群（必须在配置里）
 *   echo "内容" | node 工具/发合并转发.js           从标准输入读
 *
 * 为什么单独写：2026-10-31 用户嫌长总结刷屏，要求走合并转发。插件的 qq_send
 * 没有这个入口，直接调 OneBot 的 send_group_forward_msg 最快；这里统一封装。
 * 调用层走 ./lib/onebot.js（读配置 + 3001 假成功时自动退 3000）。
 */
const fs = require('fs');
const { call, config, defaultGroup, knownGroup } = require('./lib/onebot.js');

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const groupId = opt('-g', defaultGroup());
if (!groupId) { console.error('没有群号可用'); process.exit(1); }
if (!knownGroup(groupId)) { console.error(`群 ${groupId} 不在配置里，不发`); process.exit(1); }

const title = opt('-t', '');
const file = opt('-f', '');

let text = '';
if (file) text = fs.readFileSync(file, 'utf8');
else if (!process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
else {
  console.error('用法：node 发合并转发.js [-t 标题] [-f 文件] [-g 群号]，或用管道喂内容');
  process.exit(1);
}

text = String(text || '').trim();
if (text === '') { console.error('内容是空的'); process.exit(1); }

// 按空行切节，一节一个转发节点；单节封顶 1500 字（QQ 侧太长会难读）
const chunks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
const nodes = chunks.map((chunk, i) => ({
  type: 'node',
  data: {
    user_id: String(config.selfUin || ''),
    nickname: title ? `${title}${chunks.length > 1 ? ` ${i + 1}/${chunks.length}` : ''}` : '肥鱼',
    content: [{ type: 'text', data: { text: chunk.slice(0, 1500) } }],
  },
}));

(async () => {
  const j = await call('send_group_forward_msg', { group_id: Number(groupId), messages: nodes });
  const id = (j && j.data && (j.data.message_id || j.data.res_id)) || 0;
  if (Number(id) > 0) console.log(`√ 已发合并转发（${nodes.length} 节），id=${id}`);
  else console.log('× 没发成：', JSON.stringify(j).slice(0, 200));
})();
