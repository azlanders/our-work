/**
 * lib/onebot.js —— 工具脚本共用的 OneBot 调用层
 *
 * 用途：读 qq-bridge 配置（地址 / token / 群号 / selfUin），并提供 call() 调接口。
 * 为什么抽出来：读卡片.js、发合并转发.js 原来各抄了一份「读配置 + 拼 URL + 带 token」的代码，
 * 改一处忘另一处的风险实打实存在。统一到这里，以后换端口、换 token 位置只改一个文件。
 *
 * 用法（CommonJS）：
 *   const { call, config } = require('./lib/onebot.js');
 *   const r = await call('get_group_msg_history', { group_id: 123, count: 3 });
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'qq-bridge.config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const config = loadConfig();

/** 默认群号：配置里 routes.group 的第一个 */
function defaultGroup() {
  const groups = Object.keys((config.routes && config.routes.group) || {});
  return groups[0] || '';
}

/** 这个群号在不在配置里 */
function knownGroup(id) {
  const g = String(id || '');
  if (g === '') return false;
  const routes = Object.keys((config.routes && config.routes.group) || {});
  const uins = (config.groupUins || []).map(String);
  return routes.includes(g) || uins.includes(g);
}

function baseUrl() {
  return String(config.onebotHttp || 'http://127.0.0.1:3100/').replace(/\/?$/, '/');
}

/**
 * 调一次 OneBot 接口。
 *
 * 自动兜底：VPS 上配置写的 3001 是代理，对部分接口（拉历史消息等）会返回
 * 「NapCat4 Is Running」这种 data 空的假成功；遇到空 data 且地址是 3001 时，
 * 自动换到 NapCat 本机 3000 再试一次（2026-10-31 踩过）。
 */
async function call(action, body, options = {}) {
  const base = options.base || baseUrl();
  const token = String(config.token || 'localtoken');
  const url = base.replace(/\/?$/, '/') + action;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();

  const emptyData = json && json.data !== undefined && json.data !== null
    && typeof json.data === 'object'
    && Object.keys(json.data).length === 0;

  if (emptyData && /:3001\/?$/.test(base) && !options.retried) {
    const alt = base.replace(/:3001\/?$/, ':3000/');
    return call(action, body, { ...options, base: alt, retried: true });
  }
  return json;
}

module.exports = { config, call, defaultGroup, knownGroup, baseUrl, CONFIG_PATH };
