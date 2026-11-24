# 多 Bot 与模板同步规则

> 目的：以后加 bot 不用从零抄一遍；一个 bot 改了通用代码，其它 bot 和模板都要跟上。
> 本文档在两个实例里各放一份，内容相同。模板目录里也放一份。

## 一、什么必须同步，什么绝不碰

判断标准：**换个 bot，内容是否还一样**。

| 必须同步（通用） | 绝不碰（实例独有） |
| --- | --- |
| `共享/工具/` 下的 `.mjs .js .html .py .sh .md .css` | `SOUL.md`、`门牌.md`、`梗知识.md`、`热记忆.md` |
| `目录与文件规矩.md`、`BOT-RUNBOOK.md` | `记忆/`、`日记/`、`群聊日志/`、`表情库/` |
| 工具里的通用配置：`判据清单.md`、`闭环白名单.json` | `收到的图片/`、`收到的文件/`、`屏幕/`、`下载/`、`logs/` |
| systemd unit 结构、看门狗脚本结构、SnowLuma onebot 配置结构 | `qq-bridge.config.json`（UIN/端口/token/sessionId） |
| | `cordis.patch.yml`（路径、视频词条；人设只写 `SOUL.md`，不再写 `personaPrefix`） |
| | `共享/变更.md`、留言板、自拍、工作日志、总结、会话资料 |

「同步」指复制代码和文档；桥配置、人格、记忆一律按实例单独维护。
`参数.json / 工作.json / 地图.json / 心跳表.json / 服装表.json / 家具表.json / 商店-生活.json`
是「仅初始化文件」——安装新 bot 时会带上，之后同步和推送都不碰，免得把某个 bot 的游戏数据推给别人。

## 二、路径占位符

通用代码里不许出现别的 bot 的绝对路径。模板统一写成：

- `{{BOT_ROOT}}` —— 工作区
- `{{DSH_ROOT}}` —— DSH 数据目录
- `{{SVC_BOT}}` / `{{SVC_PANEL}}` / `{{SVC_GATEWAY}}` / `{{SVC_UPSTREAM}}` / `{{SVC_GPT}}` —— 服务名，默认 `$BOT_NAME-*`，老实例对不上就在 env 里写实际值
- `{{PATCH_SCRIPT}}` / `{{PATCH_DIR}}` —— 插件补丁脚本和快照目录，默认 `reapply-patches-$BOT_NAME.sh` / `/root/$BOT_NAME-patches`

同步脚本负责两个方向的替换。新写的代码如果引用了本机路径，优先读环境变量
（`QQ_AUTONOMY_MEM`、`QQ_ITEM_TOOLS`、`DSH_HOME`），没有环境变量时才落回默认值。

## 三、改动的标准流程

1. 在一个实例上改，验证主路径。
2. `/data/bot-template/同步模板.sh <实例工作区> --vars instances/<实例>.env`
   —— 把通用文件灌进模板，同时把路径、服务名、UIN 还原成占位符。
   脚本对「两边内容不同」的文件只列冲突不覆盖；确认实例版本更新后加 `--force`。
3. `/data/bot-template/自检.sh` —— 残留扫描、占位符核对、临时装一个新 bot、`node --check`。
4. 其它实例跟上：`/data/bot-template/推给所有实例.sh instances/<实例>.env`。
   跨机先在目标机拉模板，再跑推送：
   `rsync -az -e 'ssh -p <模板机SSH端口>' root@<模板机>:/data/bot-template/ /data/bot-template/`
5. 每个实例跑 `node 共享/工具/契约检查.mjs`，0 项不对才算同步干净。
6. 往实例的 `共享/变更.md` 追一行。

## 四、加新 bot

1. `cp /data/bot-template/vars.example.env /data/bot-template/<name>.env` 并填值
2. `sudo /data/bot-template/安装新bot.sh /data/bot-template/<name>.env`
3. 按脚本末尾打印的步骤：独立 QQ 目录、扫码、起服务、加 timer
4. 新 bot 上线前，在 `共享/变更.md` 登记一行

## 五、端口与资源约定

同一台机器上端口不能冲突。现有分配：

| 用途 | {{ALT_BOT_DISPLAY}} | bot | 下一个（示例） |
| --- | --- | --- | --- |
| OneBot HTTP | 3000 | 3010 | 3020 |
| OneBot WS | 8080 | 8090 | 8100 |
| dsh web | 3080 | 3081 | 3082 |
| WebUI 对外 | 39273 | 39274 | 39275 |
| 模型网关 | 39301 | 39401 | 39501 |

每个 bot 单独一个 `dsh-bot` 服务、单独一个 DSH 数据目录、单独一个 workspace。
SnowLuma 是「一个 service 注入本机所有 QQ 进程」，加 bot 不需要新 service，
但需要独立的 QQ 安装目录和独立 Xvfb 显示号。

## 六、验证清单（新 bot 上线前）

- [ ] `curl -X POST http://127.0.0.1:<HTTP_PORT>/get_login_info` 返回 `user_id`
- [ ] `ws` 日志出现「已连接」
- [ ] 发一条自己的测试消息，日志出现「接收」和「已转发回复」或 `qq_send final`
- [ ] 看门狗 timer 已启用，跑一次退出码为 0
- [ ] 不在任何别的 bot 的目录里写文件
