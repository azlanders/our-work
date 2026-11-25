# 通用补丁

这些补丁不属于某个 bot，是全局 dsh 或压缩插件的通用修复。应用前先备份目标文件。

## dsh-agent-loop-system-dedup.patch

目录：

```bash
cd /usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
patch -p1 --dry-run < /data/bot-template/patches/dsh-agent-loop-system-dedup.patch
patch -p1 < /data/bot-template/patches/dsh-agent-loop-system-dedup.patch
node --check dsh-agent-loop/lib/index.js
```

## dsh-live-compact-drain.patch / dsh-live-compact-biggate.patch

目录按实例的 `DSH_ROOT` 换：

```bash
cd /data/bot-dsh/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-drain.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-drain.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-biggate.patch
node --check dsh-live-compact/plan.js
node --check dsh-live-compact/index.js
```

## dsh-live-compact-dedupe.patch

压缩卡去重：同一张 spine/归档卡里重复出现的模板句和相同的「今天你做过这些」块只保留第一次。跟上面两个补丁同目录应用。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-dedupe.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-dedupe.patch
node --check dsh-live-compact/plan.js
```

两个实例的 `DSH_ROOT` 各不相同，按 `instances/*.env` 里的 `DSH_ROOT` 进对应目录。

## dsh-live-compact-preset-threshold.patch

`dsh-live-compact/gate.js` 里给「预设」用的默认阈值是 0.8，预设一被换上就等于涨到八成窗口才压一次。这个补丁把它改成 0.15，跟 `cordis.patch.yml` 里 `compaction-spine` 的口径一致。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-preset-threshold.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-preset-threshold.patch
node --check dsh-live-compact/gate.js
```

## dsh-onebot-receipt-unknown-ttl.patch

修的是「发送结果 unknown 的收据永久阻塞同一个接收方」：unknown 超过 30 分钟转成 not-sent，并设冷却，主动搭话不再永远说「没有可用会话」。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-onebot-receipt-unknown-ttl.patch
patch -p1 < /data/bot-template/patches/dsh-onebot-receipt-unknown-ttl.patch
node --check dsh-onebot-channel/receipt-transaction.mjs
```

改完要重启该实例的 bot 服务才生效。

## dsh-agent-loop-runtime-dedup.patch

目录同 `dsh-agent-loop-system-dedup.patch`：

```bash
cd /usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
patch -p1 --dry-run < /data/bot-template/patches/dsh-agent-loop-runtime-dedup.patch
patch -p1 < /data/bot-template/patches/dsh-agent-loop-runtime-dedup.patch
node --check dsh-agent-loop/lib/index.js
```

`runtime-context` 每轮都变（时间、状态、SOUL），旧快照一直留在对话表面，同一份 SOUL 叠五六份。
这个补丁在 append 新快照前，把表面里所有旧快照压成一句 `Current runtime context: none.`，只留最新一份完整内容。
验证：`fish-usage-log.jsonl` 的「对话字」不再逐轮线性上涨。

## dsh-live-compact-card-slim.patch

目录按实例的 `DSH_ROOT` 换：

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-card-slim.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-card-slim.patch
node --check dsh-live-compact/plan.js
node --check dsh-live-compact/index.js
```

压缩卡片（spine extract）原来把本段的**所有**用户消息原样重抄一遍，其中绝大多数是每轮状态快照，
卡片一多就互相重复，压缩等于没压（实测 2958 字只省 496）。现在只保留真正的用户发言，
跳过状态/记忆/卡片自身、跳过已进 Kept lines 的行，并去掉「原文指针」「Matched lines」这类调试段、
去掉重复的英文 preamble 和双写 `Spine extract.`。
改完重启该实例的 bot 服务。

## dsh-live-compact-usertrim-cpmerge.patch

两件事，都是「压缩卡越压越大」的根因：

1. 卡片里「较早的用户消息」原来把整条正文原样抄进去，而每轮投递前面都挂着 1.5k 上下的
   状态/运行信息（可观测运行信息 / 你现在状态 / 关于他 / Current runtime context）。
   结果压缩卡自己变成 14k–29k，历史里还越积越多。补丁只留真正说过的话（上限 800 字）。
2. 旧压缩卡不参与下一次切分，每压一次就多留一张卡（实测两张 14k + 9.7k 同时挂在 surface）。
   补丁把紧挨切点的旧卡并进新 span，让新卡吸收它们，历史里只留最新一张。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-usertrim-cpmerge.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-usertrim-cpmerge.patch
node --check dsh-live-compact/plan.js
node --check dsh-live-compact/index.js
```

改完要重启该实例的 bot 服务才生效。

## dsh-live-compact-cardslim2.py

压缩卡收口，配合 `dsh-live-compact-usertrim-cpmerge.patch` 之后跑：

- 卡片「较早的用户消息」只留最近 3 条要点，整块上限 1500 字；
- 已落盘的旧卡在每回合开始时就地剥掉整段状态/运行快照；
- 压缩摘要请求单条 8000 字、整包 40000 字封顶（一次 2MB 工具原文曾打出 150 万 token）；
- 两个实例的 plan.js/index.js 统一（含 keptLines 去重）。

```bash
python3 /data/bot-template/patches/dsh-live-compact-cardslim2.py <DSH_ROOT>/profiles/web/node_modules
node --check <DSH_ROOT>/profiles/web/node_modules/dsh-live-compact/plan.js
node --check <DSH_ROOT>/profiles/web/node_modules/dsh-live-compact/index.js
```

可重复执行；改完重启 bot 服务。

## token 止损补丁

这组补丁来自一次 150 万 token 的单次请求复盘。按顺序跑，跑前先备份目标文件：

1. `portable_onebot.py <lib目录> <实例名> --apply`，再 `fix_portable.py <lib目录> <实例根>`：
   把 onebot 插件里写死的 `/data/<实例>-workspace` 改成 `QQ_WORKSPACE` 优先，默认值保留实例路径。
2. `patch_video_cap.py <tool.js>`：`qq_watch_video` 默认不再回传 base64 分镜图；只有带 `focus` 时才回 1 张 ≤120KB 的图。
3. `patch_video_density.py <tool.js>`：看视频固定 `maxSheets=1`、`detail=low`，减少时间轴文本。
4. `patch_recall_cap.py <dsh-rofm/config.json>`：自动回忆上限降到 12k 字符 / 8 块 / 单轮 8k。
5. `patch_rofm_runtime_skip.py <dsh-rofm/lib/passive-archive.js>`：归档时跳过 runtime-context 快照，避免旧状态被反复回忆。
6. `patch_rofm_noprestep.py <dsh-rofm/config.json>`：关掉 rofm 每轮 pre-step 压缩，让宿主 `compaction-basic`（Codex 结构）接管。
7. `patch_zoom_schema.py <dsh-video-storyboard/src/storyboard/register.js>`：精简 `video_zoom` 冷门参数说明，保留全部参数和核心说明。
8. `patch_bash_desc.py <dsh-tool-bash/lib/index.js>`：把 bash 的长描述压到约 1/3，保留删除/移动前的路径确认和沙箱拒绝提示。

## dsh-live-compact-scaffold.patch

压缩卡片（spine-checkpoint）原来会把「（可观测运行信息…」「Current runtime context」「[memory] …」这些每条投递都会重新生成的脚手架原句抄进去，旧卡片一路带到后面每一轮，一张卡 14k 字。这个补丁让建卡时先丢掉这些行，旧卡在下一轮由 `scrubCardText` 就地重写。

先应用 `dsh-live-compact-card-slim.patch`，再打这个：

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-scaffold.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-scaffold.patch
node --check dsh-live-compact/plan.js
```

## patch_llm_retry.py

`dsh-llm` 里请求重试的默认次数是 5。上游 404/空响应时一次回合会连打 5 次，每次都是 40k+ token，额度就是在这里被吃掉的。实例的 `cordis.patch.yml` 里虽然写了 `maxRetries: 1`，但那个 provider 配置没生效，实际走的还是默认值。

```bash
python3 /data/bot-template/patches/patch_llm_retry.py
node --check /usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js
```

改的是全局 dsh 包，升级 dsh 会被覆盖，升级后重打。

## dsh-live-compact-scaffold2.patch

在 scaffold 补丁之上再砍两处：旧 `Spine extract.` 卡也参与清理（原来直接跳过，导致旧卡里的运行快照永久留在上下文里）；行内接在工具输出后面的运行卡（`│ …（可观测运行信息：…`）只截掉卡片部分；`scrubCardText` 对内容相同的 seq 行去重。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-live-compact-scaffold2.patch
patch -p1 < /data/bot-template/patches/dsh-live-compact-scaffold2.patch
node --check dsh-live-compact/plan.js
```

补丁只在下一回合结束时重写旧卡（`finishTurn` 里的 `scrubCards`），改完不用额外跑脚本。

## dsh-onebot-channel-proactive-quiet.patch

主动搭话回执被取消（她这轮 qq_pass / 没开口）时也记一次 `lastProactiveAt`。
不修的话冷却 15 分钟一到就重问一遍，每轮 28k 上下文，一晚几十轮一句话没发。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-onebot-channel-proactive-quiet.patch
patch -p1 < /data/bot-template/patches/dsh-onebot-channel-proactive-quiet.patch
node --check dsh-onebot-channel/lib/outbound.js
```

## dsh-onebot-channel（宿主 fork，别升级 npm 版）

- `dsh-onebot-channel-quiet-backoff.py`：主动搭话空转。她选择 `qq_pass` 后回执冷却原来固定 15 分钟，冷却一过又烧一整轮 28k 上下文，一晚几十轮一句没发。改成按连续空转次数指数退避（15/30/60/120/240 分钟，封顶 4h）。改 `receipt-transaction.mjs`（新增 `quietStreak`）+ `lib/outbound.js`。
- `dsh-onebot-channel-video-image-shrink.py`：`qq_watch_video` 分镜图原来 >120KB 直接不挂（等于她看不见画面），<120KB 也可能一次烧掉几十万 token。改成 ffmpeg 压到 900 宽 JPEG（≤60KB）再挂；压不下去才不挂。改 `lib/tool.js`。

用法：`python3 patches/<name>.py <实例的 dsh-onebot-channel 目录>`，脚本幂等，打过会跳过。

## dsh-onebot-channel-poll-inner-trim.patch

`内心.md` 的前两段是数值快照（精力/困意/心情/体力感/好感/熟悉/怨/别扭/亲近），同一轮的状态段和 `[态]` 已经各报过一遍。补丁在拼 `[内心]` 前剥掉这段，只留今日记录/愿望/怕/惦记/心里话/锚/梦素材。

```bash
cd <DSH_ROOT>/profiles/web/node_modules
patch -p1 --dry-run < /data/bot-template/patches/dsh-onebot-channel-poll-inner-trim.patch
patch -p1 < /data/bot-template/patches/dsh-onebot-channel-poll-inner-trim.patch
node --check dsh-onebot-channel/lib/poll.js
```

## patch_soul_section.py

SOUL 原来用 `systemPrompt.context()` 注册，每轮把整份快照追加进历史；SOUL 内容不变却重发（40 份 ≈ 70k 字）。脚本改成优先用 `systemPrompt.section()`（宿主只留最新一份），没有就回退 `context`；`interpolate:false` 防止 SOUL 里的 `{{...}}` 被当变量。

```bash
python3 /data/bot-template/patches/patch_soul_section.py <DSH_ROOT>/profiles/web/node_modules/dsh-onebot-channel/lib/index.js
node --check <DSH_ROOT>/profiles/web/node_modules/dsh-onebot-channel/lib/index.js
```

## dsh-live-compact-header-dedupe.py

压缩卡自带 `Spine extract.` 头，`checkpointMessage` 又拼一段 preamble，同一句头在每条 checkpoint 里出现两遍。修 `index.js`（叠进去前剥掉卡片自带的头）+ `plan.js`（`tplSeen` 补上卡片头/分节标题，嵌套卡片不再重复）。

用法：`python3 patches/dsh-live-compact-header-dedupe.py <实例的 dsh-live-compact 目录>`，幂等。改完 `node --check index.js plan.js`，重启该实例 bot 生效。

## dsh-onebot-channel-quiet-hours.py

`qq-bridge.config.json` 的 `proactiveQuietFrom/To` 原来没有被任何代码读取，夜里照样每 15 分钟主动搭话。`runProactiveOnce` 现在先过静默时段闸门（`force` 手动触发放行）。

用法：`python3 patches/dsh-onebot-channel-quiet-hours.py <dsh-onebot-channel 目录>`，幂等。改完 `node --check lib/proactive.js`，重启该实例 bot 生效。

## dsh-rofm-wake-probe.py

qq-bridge 的投递头（`（可观测运行信息：…）`、`（注意：…）`、`（关于他：…）`）原来没被 `stripInjectedHeaders` 认出（正则缺 `可观测运行信息`），整段前缀被写进 `memory/…/context.json`；纯唤醒/续跑 probe 更是整条模板进记忆，召回后又注入，形成自激。补丁改 `lib/surface.js`：投递头补进 `INJECTED_HEADER_RE` / `HINT_MARKER_RE`，纯 probe 整条只留 `[唤醒/运行提示，已省略]`。

用法：`python3 patches/dsh-rofm-wake-probe.py <dsh-rofm 目录>`，幂等。改完 `node --check lib/surface.js`。已有被污染的记忆用 `node` 调 `stripInjectedHeaders` 逐条擦洗 `context.json`（先备份到 `/root/bak2/`）。

## dsh-live-compact-1.1.12-port.tar.gz

从 1.0.8（本地补丁）升到 npm 1.1.12，并把本地补丁重新落到新版上：

- `plan.js`：`trimUserText`/`dropScaffoldLines`/`scrubCardText`（卡片剥运行快照、去重），
  `earlierUsers` 只留最近三条、整块 ≤1500 字；`pointerOnlyText` 也用 `trimUserText`。
- `index.js`：`turn/start` 和轮末各洗一遍旧卡（`scrubCards`）；`bigGate` 超门不再直接跳过，
  转成强制 drain 砍回 `keepRoundTokens`。
- 阈值不再改常量，走环境变量 `SPINE_THRESHOLD_RATIO=0.15`（写进实例的 `*.env`）。
- `index.js`：drain 条件去掉 `cloud &&`。原来引擎被认成 `local`（gemini-web 上游不在 pi-ai 目录里）时，
  只有 48k 紧急线才收，上下文会一路涨到几十万每轮全量重发。现在按 `keepRoundTokens`(默认 32000) 投影照常收。

整包是「1.1.12 + 上面这些改动」，装法：

```bash
cd <DSH_ROOT>/profiles/web/node_modules
tar xzf /data/bot-template/patches/dsh-live-compact-1.1.12-port.tar.gz
node --check dsh-live-compact/index.js && node --check dsh-live-compact/plan.js
```

前提：宿主的 `@deepseek-ai/dsh-compaction*` 要 ≥ 0.2.0-rc.2（本机是 0.2.2-rc.1）。
装完重启对应的 `*-bot.service`。1.0.8 时代的 `dsh-live-compact-*.patch` 对 1.1.12 不适用。

## dsh-live-compact：到 minTokens 就 drain

实测：`drain` 原来只由 `超门 || projected || last >= 48000` 决定，而 `projected` 依赖
`maxTurnGrowth > 0`。`turnBase` 每轮被重置后，多数回合的 growth 算出来是 0，
于是上下文到 31.7k 仍在 `cut-skip: no-legal-span, drain:false`，压缩从不真正切。

改法（`dsh-live-compact/index.js`）：

```js
const drain = 超门 || projected || last >= URGENT_TOKENS
  || (Number(settings.minTokens) > 0 && last >= Number(settings.minTokens));
```

这样到了 `minTokens`（当前 20000）就进入 drain，`selectCutIndexes` 会走跨用户的
回退逻辑再判断有没有合法切点；没有就继续跳过，不会硬切。

已落到 `/data/bot-template/dsh/vendor/dsh-live-compact/index.js`，新 bot 直接带走。
现有实例要改的话，直接复制模板 vendor 里的 `index.js`，`node --check` 后重启 bot。
