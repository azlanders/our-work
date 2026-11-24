# hajimi（QQ 机器人）运维手册

## 1. 服务拓扑

```
QQ 客户端（SnowLuma，systemd: snowluma.service；OneBot HTTP 127.0.0.1:3011 / WS 127.0.0.1:8090）
  ↓
DSH Web 宿主（systemd: {{SVC_BOT}}.service，127.0.0.1:3081，插件 dsh-onebot-channel）
  ↓
多模型接口网关（systemd: {{SVC_GATEWAY}}.service，127.0.0.1:39401，{{BOT_ROOT}}/共享/工具/接口网关.mjs）
  ↓
上游模型接口（{{DSH_ROOT}}/{{BOT_NAME}}-fleet.json 定义槽位、型号优先级、倍率与冷却）
```

配套常驻服务：
- `{{SVC_PANEL}}.service`（8788）：状态 / 用量 / 日记 / 留言板 / 调试面板（`{{BOT_ROOT}}/共享/工具/面板.mjs`）
- `{{SVC_WATCHDOG}}` timer：每分钟健康巡检，掐在「回合卡住 / WS 断线」那一层（`/root/运维服务/{{SVC_WATCHDOG}}.sh`）
- `{{SVC_GPT}}.service`（可选）：本机 GPT-SoVITS 语音合成（127.0.0.1:9880），供 `语音合成.mjs` 与面板试听

协议端是 SnowLuma，一个进程挂多个 QQ。新 bot 不再单独开 NapCat。

## 2. 常用命令

```bash
# 核心服务
systemctl status snowluma {{SVC_BOT}} {{SVC_GATEWAY}} {{SVC_PANEL}}

# 桥接与投递日志（她收没收到、哪里拒投，都在这）
tail -f {{DSH_ROOT}}/qq-bridge-load.log

# 模型请求与 token 流水（每行带 系统字/对话字/工具字/入/出）
tail -f {{DSH_ROOT}}/fish-usage-log.jsonl

# 网关最近一次请求体（排查上下文为什么大；存在 /tmp/hajimi-dump.on 时才写）
cat /tmp/hajimi-req-full.json

# 健康与契约门禁
cd {{BOT_ROOT}}/共享/工具 && node 自检.mjs && node 契约检查.mjs && node 全套验收.mjs

# 改插件代码后保存补丁快照
/root/运维服务/reapply-patches.sh --save
```

## 3. 关键配置与路径

- 环境变量：`/etc/hajimibot.env`（`DEEPSEEK_BASE_URL=http://127.0.0.1:39401`、`DSH_HOME={{DSH_ROOT}}`）
- 舰队（槽位、型号优先级、倍率、峰谷、冷却）：`{{DSH_ROOT}}/{{BOT_NAME}}-fleet.json`
- 上游钥匙：`{{DSH_ROOT}}/fish-api-keys.json`；用量：`{{DSH_ROOT}}/fish-usage-log.jsonl`
- QQ 桥：`{{DSH_ROOT}}/qq-bridge.config.json`（`routes.private` 里按 QQ 号钉会话）
- 投递绑定：`{{DSH_ROOT}}/fish-qq-memory-v1/<sha256(sessionId)>.txt`，内容是 `private-<QQ号>`
- 宿主插件：`{{DSH_ROOT}}/profiles/web/node_modules`、`vendor/`
- 压缩：`{{DSH_ROOT}}/compaction-spine`（shadow 原文备份 + `spine-cuts.jsonl`）
- 统一心跳：`{{BOT_ROOT}}/共享/工具/心跳.mjs` + `心跳表.json`

## 4. 她不回话时按这个顺序查

1. `curl -s -X POST http://127.0.0.1:3011/get_login_info -H "Authorization: Bearer "` —— 502 就是协议端没登录，扫码，别改代码。
2. `tail -20 {{DSH_ROOT}}/qq-bridge-load.log` —— 看是 `OneBot HTTP 502`（没登录）、`拒绝 QQ 投递`（绑定/来源不符），还是根本没轮询到消息。
3. `systemctl is-active {{SVC_BOT}}` 与 `journalctl -u {{SVC_BOT}} -n 50` —— 宿主崩了没有。
4. `tail -3 {{DSH_ROOT}}/fish-usage-log.jsonl` —— 最后一条请求是什么时候、入多少。没有记录说明请求没到网关。
5. `curl -s http://127.0.0.1:39401/__fleet/state` —— 看槽位是否全在冷却、`lastErr` 是什么。

## 5. 加一个 bot

1. `cp vars.example.env mybot.env`，填 UIN、端口、目录、服务名。
2. `./安装新bot.sh mybot.env`（生成 workspace、桥配置、systemd 单元）。
3. 按脚本最后打印的步骤：在 SnowLuma 里加这个 QQ、扫码、把 `{{BOT_NAME}}-fleet.json` 的钥匙补上。
4. `./自检.sh` 通过再上线；通用代码改动先 `./同步模板.sh <实例工作区> --vars instances/<实例>.env`，再 `./推给所有实例.sh instances/<实例>.env`。
