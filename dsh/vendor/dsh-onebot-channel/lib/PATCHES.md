# 这个目录被改过的文件

插件版本 0.11.0，升级后改动会丢，跑 `/root/reapply-patches.sh` 恢复（备份在 /root/backups/日期/）。

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `poll.js` | 自己消息跳过、未读上下文过滤 selfUin；群消息防抖（连发只回最后一条）；**轮询通路补同一套连发防抖**（2026-10-31：一批里只投时间最新的那条要回的，紧急/停手指令全投，防「快速连说三句回三遍」）；请求事件落盘 qq-requests.jsonl；@别人且没点名时跳过；主人/名字提及免@门控 | 群聊噪音、冷启动卡顿、好友申请可见性 |
| `outbound.js` | 发图/发文件/分段容错；正文图片链接转图；本机路径抹成「（地址略）」；调试群 auditDisabledGroups 全豁免；「（本轮不发）」类占位与舞台说明吞掉 | 出站体验与合规 |
| `outbound.js` + `deliver.js` | inactive context 时不再丢弃：deliver 提供 redeliver 回调，outbound 等在 2 秒后把这条消息重投一次（最多 2 次） | 冷启动窗口里消息静默丢失 |
| `poll.js` + `tool.js` | 根治重复回复：poll 导出 markHandled，qq_wait 把旁路读到的消息标进 seenIds，投递路径就不再投一次 | 同一句话答两遍 |
| `outbound.js` + `poll.js` | 喊停就停：收到「别找了/算了/取消/先别」时立刻回「停了」，并把这一轮待发的回复标成丢弃（dropPendingReplies）；代价是那一轮白算 | 中断不动正在跑的回合 |
| `tool.js` | qq_send 增加 images/files 参数 | 发图发文件 |
| `collect.js` | 收藏表情改传本机路径、回查 emoji_id、写本地命名表 | NapCat 不认 file:// 且不返回 id |
| `custom-faces.js` | 本地命名表，按名字找收藏表情 | NapCat 不支持 modify_custom_face |
| `index.js` | flushOutbound(ctx) 传入 ctx；WS 事件加 catch | inactive context 重投要 ctx；unhandledRejection 会杀进程 |
| `sessions.js` | 新增 forceResume()（清理缓存后重挂载） | 上下文回收后尝试换新 agent |

改完必须 `node --input-type=module -e "await import('./xxx.js')"` 验加载，再 `systemctl restart dsh-bot`。

## 2026-11-16 P1（批次579）

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `state.js` | `saveState` 改成 tmp→rename 原子写 | 进程崩在写盘中途会留下半截 JSON，游标全丢 |
| `memory.js` | 关系卡三处写入统一走 `写原子()` | 同上；30s 节流期的写盘也可能被打断 |
| `outbound.js` | 删掉 `recentSends` / `DEDUPE_MS` | 只有声明没有读取，是死代码 |
| `tool.js` | `qq_send` 返回 `{ok, message_id, reason}`；静默时明确失败，空回执抛错 | 原来被静默/取消也返回 `message_id:0`，模型以为发出去了 |
| `qq-bridge.config.json` | `allowSendToAny` 改为 false | 白名单与 routes 完全一致，没有理由再开着逃生阀 |
| `state.js` | 加 `loaded` 闸：没走 `loadState()` 的进程，`saveState()` 不写盘 | 2026-11-16 事故：独立进程 import 后 `saveState({})` 把线上游标覆盖成空态 |

## 2026-11-16 批次 579（P0/P1 真实优化）

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `tool.js` | `qq_pass` / `qq_close` 调宿主 `concludeTurn()` | 974 次 pass 全部在「工具回填」再跑一轮 40k 上下文；回合应直接结束 |
| `state.js` | 读到坏 JSON 时先 `copyFileSync` 留档再继续 | 否则下一次 saveState 用空态永久覆盖 |
| `outbound.js` | 追问武装 / 续跑钩子的空 catch 补日志 | 失败不再无声无息 |
| `index.js` | 卸载清理、主动搭话、关系卡 flush 的空 catch 补日志 | 卸载期丢数据现在看得见 |
| `proactive.js` / `photoWatch.js` / `tool.js` | 落盘失败补日志 | 同上 |
| `qq-bridge.config.json` | 工具白名单 41 → 35（去掉 6 个零调用） | 工具声明 26.7k 字符/请求，砍掉约 1/6 |
