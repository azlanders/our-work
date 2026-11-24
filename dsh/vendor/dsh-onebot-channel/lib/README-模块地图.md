# lib/ 模块地图

> 48 个文件，改之前先在这里找到「我要动的是哪一段、谁会跟着受影响」。
> 2026-11-04 整理：这次清掉了 82 个 `.bak`（在 `/root/bak2/_归档-lib备份-20261104/`），
> 删了 5 处死导入，把两组重名函数改了名。**没有合并文件** —— 检查过几组看着像重复的
> （碎片召回/碎片话题、五个表情模块、四个发送层），职责其实不同，合并只会把语义搅乱。

## 一、入口

| 文件 | 干什么 |
|---|---|
| `index.js` | 插件入口。注册工具、挂设置页路由、注入 ctx、退出时刷盘。宿主只认这个 |
| `client.js` | 浏览器半侧（手写 `__ModuleLoader__` bundle，不经构建）。设置页 UI 在这 |
| `api.js` | 设置页的同源接口 `/api/qq-bridge/*` |
| `instance.js` | 单实例锁。防止两套收发循环同时跑（会把同一条消息回两遍） |
| `health.js` | OneBot 协议端探活 + 错误分级 |
| `snowluma.js` | 从 SnowLuma 本地配置里找 WS 地址和 token |

## 二、入站：消息怎么进来

| 文件 | 干什么 |
|---|---|
| `ws.js` | OneBot 正向 WebSocket 事件入口（实时） |
| `poll.js` | **最大的一个（2600 行）**。私聊/群聊两个轮询循环、去重、未读判定、投递编排、WS 事件落地。改行为先从这里找 |
| `backfill.js` | 上线补历史（掉线窗口的消息不能丢） |
| `state.js` | 轮询游标的持久化（`seq` / `seenIds`） |
| `history.js` | 消息历史检索（群 + 好友） |
| `onebot.js` | OneBot HTTP 调用 + 消息段解析。**所有出站最终都从这走** |

## 三、出站：她的话怎么发出去

| 文件 | 干什么 |
|---|---|
| `outbound.js` | **第二大（1260 行）**。回复发回 QQ：排队、去重、撤回、分段时机、静默判定、追问武装点。改发送行为先看这里 |
| `deliver.js` | 把消息投进 DSH 会话 + 路由查询（哪个群对哪个 session） |
| `split.js` | 一条回复切成多条，模仿真人打字节奏 |
| `sendapi.js` | AI 主动发消息的本地接口（不需要 QQ 那边先开口） |
| `tool.js` | 注册 `qq_send` 等工具，让会话里的她能用工具发消息 |
| `allowlist.js` | 出站目标白名单（硬闸） |
| `blocked.js` | C 档封禁清单（物理拦截） |
| `sensitive.js` | 出站内容审计（本机路径 / 凭据特征） |
| `mute.js` | 被叫停后的会话静默（只在内存，重启即清） |
| `recent-say.js` | 记「我最近在这个群/这个人这儿说过什么」 |
| `breathe.js` | **已停用**（抢答器）。只留 `cancelFiller` 给 outbound 收尾 |

## 四、判断：该不该说、什么时候说

| 文件 | 干什么 |
|---|---|
| `closure.js` | 这段对话是不是可以收了。阈值 `close 0.62 / linger 0.45` |
| `rhythm.js` | 给她「什么时候说话」的主动权（分段间隔、舞台提示识别） |
| `proactive.js` | 主动搭话：没人叫她，她自己想起来找你（60 秒 tick） |
| `followup.js` | 她问完话没人接：等场子安静下来，把情境交给她自己决定 |
| `merge.js` | 私聊「先记账，攒一会儿再回」 |
| `active-peer.js` | 群聊当前在跟谁说话（窗口 180 秒、收尾词、被 @ 别人就换人） |
| `title.js` | 从落盘日志里抠标题（设置页列表用） |

## 五、内容与媒体

| 文件 | 干什么 |
|---|---|
| `emoticons.js` | QQ 表情段（face/mface）的文本渲染与出站构造 |
| `sys-faces.js` | 官方系统表情目录的搜索与反查 |
| `custom-faces.js` | 收藏表情（商城大表情）的列举与发送 |
| `face-resolve.js` | 经典表情名 → face 段 id 的最终解析 |
| `emoji-mark.js` | 文本里的表情标记解析 |
| `贴表情.mjs` | QQ「表情回应」的收发两侧：入站翻成人话、出站 `qq_react`。**和发表情（face 段）不是一回事** |
| `images.js` | QQ 图片 → DSH 附件库 → image 块 |
| `preview.js` | 把收到的表情包以图片形式交给 agent 看 |
| `collect.js` | 把表情包存进 QQ 收藏夹 |
| `qzone.js` | QQ 空间发说说 |
| `screen.js` | `qq_screen`：看主人电脑推来的截图 |

## 六、记忆与人格

| 文件 | 干什么 |
|---|---|
| `memory.js` | 「对谁的认识」落盘（关系卡） |
| `sessions.js` | 会话列表 + 冷启动（`ensureAgent`） |
| `性格系数.mjs` | 从 16PF 记忆算行为系数；异常一律退回 1.0，绝不抛错 |
| `碎片公共.mjs` | 碎片库的读取 + mtime 缓存。`碎片召回` / `碎片话题` 共用，别再各抄一份 |
| `碎片召回.mjs` | 空场时自己想起一件旧事（weight≥0.6，4 小时冷却，两个冷却文件都看） |
| `碎片话题.mjs` | 对话里出现旧事的关键词才翻出来（weight≥0.75，2 小时冷却，命中率 25%） |

## 七、配置

| 文件 | 干什么 |
|---|---|
| `config.js` | 配置加载 / 保存 / 迁移（22 个文件依赖它） |
| `env.js` | 数据目录、日志、宿主服务取用、北京时间（37 个文件依赖它） |

---

## 三条主链路（改之前先顺着走一遍）

**一、有人说话 → 她回话**
```
OneBot WS 事件 → ws.js → poll.js（去重/未读/是否该回）
             → deliver.js（投进对应 session）→ agent 想 → outbound.sendToQQ
             → split.js（切分/间隔）→ onebot.js（发）
```

**二、她自己想发（工具 / 主动）**
```
tool.js 的 qq_send / sendapi.js 的本地接口 / proactive.js 的 tick
             → 都汇总到 outbound.sendToQQ → 同一条出站链路
```

**三、她问了没人接**
```
outbound.sendToQQ 判定「这句在等回应」→ followup.armFollowup
             → 到最早时间后：她刚说过话？场子还在响？→ 顺延
             → 真安静了 → 往她的 session 投一条情境（不替她决定说不说）
```

## 改之前容易踩的六个坑

1. **`poll.js` / `outbound.js` 两个大文件，改一行可能影响三条链路。** 改完一定跑
   `/root/qq-audit/tests/` 里对应的 `round*` 测试，别只 `node --check`。
2. **`Number(null) === 0`。** 这个坑在 `silenceBias` 和 `describeClosingAge` 上各踩过一次。
   凡是 `Number(x) || 默认值` 的形式，先想清楚 `null` / `''` 会不会被当成 0。
3. **时区只有一个出口：`env.js` 的 `bjDate / bjHour / bjMinutesOfDay / bjDayKey`。**
   2026-11-04 之前有 8 处自己写 `new Date(Date.now() + 8 * 3600 * 1000)`，已全部收拢。
   要年月日时分就拿 `bjDate()` 然后读 `getUTC*`；别再自己加八小时。
4. **性格系数只有一个出口：`性格系数.mjs` 的 `traitCoeff()`。**
   以前 outbound / split / proactive 各内联一份，其中 proactive 那份用的是 `require('node:fs')`，
   在 ESM 里直接抛错被 `catch` 吞掉 —— 系数永远是 1，用户完全看不出来。
   **这也是这个项目最容易出的 bug 类型：`catch {}` 里静默失败。** 加异常保护之前先想清楚：
   这里失败是「退回默认值」还是「功能整个不生效」，后者要想办法让它叫出来。
5. **「写好了但没人调」和「写错了」一样是 bug。**
   - `poll.refreshNicknames()` 写了却从没被调用 → 昵称兜底永远返回空串 → 消息里没带 nickname 时她看到「群友『未知』」。
     2026-11-04 改成懒加载（查不到就在后台补一次，10 分钟节流）。
   - `breathe.js` 整个模块从 11-03 起没有任何地方 arm → 抢答器一直是死的（这个是有意停用，另说）。
   - 排查方法：跑 `qq-audit/tests/体检-死导入死导出.mjs`，看「完全没人用」那张表，
     逐个问一句「这个功能该不该是活的」—— 该活的就去接线，不该活的就写清楚为什么留着。
6. **两组曾经重名的函数（2026-11-04 已改）：**
   - `proactive.notePeerActivity(key, at)` ← 原名 `notePeerSpoke`，2 个参数，记「对方刚说话」的时间
   - `active-peer.notePeerSpoke(groupId, peerUin, text, atList, selfUin)` ← 没改，5 个参数，记群聊对话对象
   - `memory.flushMemoryPersist()` ← 原名 `flushPersist`，刷关系卡；`proactive.flushPersist()` 刷主动搭话表
