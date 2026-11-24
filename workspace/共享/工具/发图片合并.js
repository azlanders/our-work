#!/usr/bin/env node
/**
 * 发图片合并.js —— 把几张图打成一个 QQ 合并转发发出去（别一张条刷屏）
 * 用法：node 发图片合并.js -t 标题 -g 群号 图1 图2 ...
 * 为什么单独写：发合并转发.js 只拼文本段；OneBot 的转节点 content 里其实也能放 image 段，
 *   这里直接把本地图片按 file:// 路径塞进去，一条合并消息里能翻看几张图。
 * 注意：图片路径必须是协议端能读到的本机路径（NapCat 已开本地文件读取）。
 */
const fs = require('fs');
const path = require('path');
const { call, config, defaultGroup, knownGroup } = require('./lib/onebot.js');

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const groupId = opt('-g', defaultGroup());
if (!groupId) { console.error('没有群号可用'); process.exit(1); }
if (!knownGroup(groupId)) { console.error(`群 ${groupId} 不在配置里，不发`); process.exit(1); }
const title = opt('-t', '图片');

const skip = new Set(['-t', '-g', title, groupId]);
const files = argv.filter((a) => !a.startsWith('-') && !skip.has(a));
if (files.length === 0) { console.error('用法：node 发图片合并.js -t 标题 -g 群号 图1 图2 ...'); process.exit(1); }

const nodes = files.map((f, i) => {
  const abs = path.resolve(f);
  if (!fs.existsSync(abs)) { console.error('找不到图：' + abs); process.exit(1); }
  return {
    type: 'node',
    data: {
      user_id: String(config.selfUin || ''),
      nickname: `${title} ${i + 1}/${files.length}`,
      content: [{ type: 'image', data: { file: 'file://' + abs } }],
    },
  };
});

(async () => {
  const j = await call('send_group_forward_msg', { group_id: Number(groupId), messages: nodes });
  const id = (j && j.data && (j.data.message_id || j.data.res_id)) || 0;
  if (Number(id) > 0) console.log(`√ 已发图片合并（${nodes.length} 张），id=${id}`);
  else console.log('× 没发成：', JSON.stringify(j).slice(0, 200));
})();
