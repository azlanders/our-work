# 通用 Bot 模板（workspace + QQ 桥）

这份模板用来加新 bot，也用来保证「改了一个 bot 的通用代码，其它 bot 和模板都跟得上」。

## 目录

```
/data/bot-template/
  README.md              本文件
  vars.example.env       实例变量样例
  instances/             每个现有 bot 的变量值（同步/推送时用 --vars 指定）
  模板清单.json           哪些文件算通用、哪些算实例独有
  安装新bot.sh            从模板生成一个新实例（只写文件，不发消息）
  同步模板.sh             实例 → 模板：把通用改动拉回模板并还原成占位符
  推给所有实例.sh          模板 → 实例：把模板按某个实例的值展开后写回去
  自检.sh                 模板自检：残留扫描 + 占位符 + 临时装一遍 + node --check
  clean-persona.py       同步后自动跑：把人设/实例文案换成中性措辞
  bridge/                QQ 桥与服务的配置模板
  workspace/             通用 workspace 骨架
  patches/               宿主和压缩插件的通用补丁
```

## 什么是「通用」

判断标准只有一条：这文件的内容里，换一个 bot 是否还是一样。

| 通用（要同步） | 实例独有（不同步） |
| --- | --- |
| `共享/工具/` 下的代码：`*.mjs *.js *.html *.py *.sh` | `SOUL.md`、`门牌.md`、`梗知识.md`、`热记忆.md` |
| `目录与文件规矩.md`、`BOT-RUNBOOK.md` | `记忆/`、`日记/`、`群聊日志/`、`表情库/` |
| `共享/工具/` 里的通用配置（`参数.json`、`工作.json` 等） | `收到的图片/`、`收到的文件/`、`屏幕/`、`下载/`、`logs/` |
| systemd unit、看门狗、SnowLuma onebot 配置的结构 | `qq-bridge.config.json`（UIN、端口、token） |
| | 人设只写 `SOUL.md`，不再写 `personaPrefix`；`cordis.patch.yml` 的结构和压缩阈值算通用，用 `同步dsh.sh` / `推dsh.sh` 同步 |
| | `共享/变更.md`、留言板、工作日志、总结、会话资料 |

模板里不出现任何具体 bot 的名字、QQ、目录、端口、服务名。代码里要用这些的地方一律写占位符：

`{{BOT_NAME}}` `{{BOT_NAME_UPPER}}` `{{BOT_ROOT}}` `{{DSH_ROOT}}` `{{QQ_HOME}}`
`{{SELF_UIN}}` `{{OWNER_UIN}}` `{{HTTP_PORT}}` `{{WS_PORT}}` `{{WEB_PORT}}`
`{{PANEL_PORT}}` `{{BRIDGE_TOKEN}}` `{{WS_TOKEN}}` `{{GATEWAY_URL}}` `{{BOT_BOOK_DIR}}`
`{{SVC_BOT}}` `{{SVC_PANEL}}` `{{SVC_GATEWAY}}` `{{SVC_UPSTREAM}}` `{{SVC_WATCHDOG}}` `{{SVC_GPT}}`
`{{PATCH_SCRIPT}}` `{{PATCH_DIR}}`

`安装新bot.sh` 和 `推给所有实例.sh` 会把它们换成目标实例的值；`同步模板.sh` 负责反向还原。

DSH profile（`package.json` / `cordis.patch.yml` / `vendor/`）不在 workspace 清单里：`同步dsh.sh` 从实例拉回模板，`推dsh.sh` 从模板推到实例，两个脚本都先打包到 `/root/bak2/`。

## 加一个新 bot

1. 复制变量样例并填好：`cp vars.example.env mybot.env`
2. 跑 `./安装新bot.sh mybot.env`
3. 按脚本最后打印的步骤：建 QQ 进程、扫码登录、拉起 `snowluma` 和 `$BOT_NAME-bot`

新 bot 建出来是空白的：没有人设、没有记忆、没有日记。人设自己写进 `SOUL.md`。

`安装新bot.sh --workspace-only` 只生成 workspace，不写 systemd/桥配置，适合先看效果。

## 改了代码之后

1. 在改动生效的实例上验证
2. `./同步模板.sh /data/<实例>-workspace --vars instances/<实例>.env`
   —— 会把通用文件拉回模板、把实例路径/服务名/UIN 还原成占位符，最后跑 `clean-persona.py` 清人名和人设文案。
   有内容冲突时脚本只列出来不覆盖；确认实例版本更新后加 `--force` 再跑一遍。
3. `./自检.sh` —— 残留扫描、占位符核对、临时装一个新 bot 并 `node --check`
4. 其它实例要跟上：`./推给所有实例.sh instances/<那个实例>.env`
   跨机时先在目标机拉模板：`rsync -az -e 'ssh -p <端口>' root@<模板机>:/data/bot-template/ /data/bot-template/`，再跑推送。

两个脚本都是先 `tar czf /root/bak2/实例-<name>-<时间>.tar.gz` 再写文件，出事能回滚。

每个现有 bot 在 `instances/` 里有一份变量。服务名和目录跟 `BOT_NAME` 对不上的实例（比如大肥鱼是 `dsh-bot` + `fish-panel`），在它的 env 里直接写 `SVC_BOT=dsh-bot`、`SVC_PANEL=fish-panel`、`PATCH_SCRIPT=reapply-patches.sh` 这类变量；更零碎的字符串再用 `EXTRA_SUBS` 补，格式 `旧串>{{占位符}};旧串>{{占位符}}`。

`参数.json / 工作.json / 地图.json / 心跳表.json / 服装表.json / 家具表.json / 商店-生活.json` 属于「仅初始化文件」：安装新 bot 时会带上，但同步和推送都不碰，免得把某个 bot 的游戏数据推给别人。

## 已知限制

- 面板里「切到另一个 bot」的开关仍是历史机制常量：前端叫 `hajimi`、主题类是 `body.hajimi-mode`。它是共用机制不是实例数据，换 bot 不用改，但别把它当成某个 bot 的名字。
- 已有的两个 bot 的显示名（按钮文案、顶栏小标题）还是各自文件里的字面量。推送模板回现有实例时如果不想改这些字面量，先 `--dry` 看一眼。
- SnowLuma 结构是「一个 service 注入本机所有 QQ 进程」，一个 UIN 一个 `onebot_<uin>.json`。加 bot 不需要新 service，但需要第二个 QQ 进程（独立安装目录 + 独立 Xvfb）。
- 每个新 bot 至少要有：独立 workspace、独立 DSH 数据目录、独立 OneBot HTTP/WS 端口、独立 `$BOT_NAME-bot` 服务。

## 宿主与插件补丁

`patches/` 里是通用补丁，新服务器/新 dsh 版本先备份再 `patch -p1 --dry-run`：

- `dsh-agent-loop-system-dedup.patch`：只保留一份有效 system prompt，避免每轮把整份人设追加一遍。
- `dsh-live-compact-drain.patch`：压缩到低水位时，尾部没有合法切点时改压更早的对话。
- `dsh-live-compact-biggate.patch`：超过最大门限也强制 drain，不把 70 万 token 的上下文整轮重发。
- `dsh-live-compact-dedupe.patch`：压缩卡里重复的模板句（「不是新指令」「不是备份路径」「[tool] 这是当时…」）和相同的「今天你做过这些」块只留第一次；实测一张 6k 字卡压到 2.5k。

应用目录写在 `patches/README.md`。

## token 开销（2026-11-23 实测）

一次普通回合的请求体拆开记在 `$DSH_ROOT/fish-usage-log.jsonl`：`系统字 / 对话字 / 工具字 / 消息数 / 工具数`。第一次测量（哈基米，36 个工具的白名单；2026-11-23 已砍到 29 个）：

| 块 | 字数 | 约合 token |
| --- | --- | --- |
| 工具 schema（36 个） | 28,978 | ~11k |
| 工具 schema（29 个） | ~24,000 | ~9k |
| system prompt | 2,591 | ~1k |
| 历史 | — | 剩下全部 |

三条经验：

- **工具面是最大固定开销**。全套 77 个工具约 4 万字（≈15k token）。`qq-bridge.config.json` 的 `工具白名单` 是唯一该维护的清单，白名单外的不下发。
- **压缩阈值决定历史的天花板**。`cordis.patch.yml` 里 `compaction-spine` 的 `thresholdRatio` 按 `最大上下文 × 比例` 触发；`0.8` 等于涨到 8 成才压一次。模板用 `0.15`（256k 窗口 ≈ 38k 触发）、`retainTokens: 8192`。
- **别让重试放大成本**。上游挂掉时每次重试都会重发整份请求体；接口网关自己做多槽位回退，宿主的 `llm-retry` 已改成 `maxRetries: 1`（默认 5 次）。配置写法见 `bridge/cordis.patch.yml.tpl` 末尾的 `llm-deepseek` 段。

## 面板与网关

模板里带两个 systemd 单元：`bridge/panel.service.tpl`（状态面板，装新 bot 时默认写）和 `bridge/gateway.service.tpl`（多模型接口网关，只有 `INSTALL_GATEWAY=1` 才写）。

- `GATEWAY_PORT`：这家 bot 自己的网关端口。默认 0，表示没有网关；面板的「模型接口」页会显示未接，**不会**去读同一台机器上别家 bot 的 39401。
- `INSTALL_GATEWAY=1` 时安装脚本会生成 `FLEET_TOKEN` 并同时写进网关和面板；网关 `/__fleet/*` 只认带这枚头的面板，别的实例读不到这家舰队。不配 token 时保持旧行为（只给回环）。
- 新 bot 第一次起面板会自动生成 `面板密钥.json`；`面板用户.json` 由主人第一次登录时写入，不随模板分发。


## 跨 bot 面板切换

`ALT_BOT_KEY` / `ALT_PANEL_PORT` 是「另一个 bot」的标识和面板端口，写在各自 `instances/*.env` 和 panel 的 systemd 单元里。

- 面板收到 `X-Bot-Target: <ALT_BOT_KEY>` 时把 `/api/*`、`/selfie/*` 转发给 `ALT_PANEL_PORT`；等于自己的 key 就走本地，不转发。
- 前端每次请求都声明当前在看谁（`X-Bot-Target: CURRENT_BOT`），不再只在选中 hajimi 时才加头 —— 原来哈基米自己的面板点「哈基米」会转给自己，认证后递归到超时。
- 不配置时默认不转发，安全。
