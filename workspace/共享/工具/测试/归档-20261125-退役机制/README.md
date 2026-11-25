# 归档 · 2026-11-25 退役机制单测

这 9 个文件锁的是已被主人指令或架构切换淘汰的旧机制，不是放宽断言凑绿。
现行门禁：`/data/bot-template` 自检 6/6、实例 `契约检查.mjs` 644/0、`自检.mjs` 100/0、`tests/test-mnemonic.mjs`。

- `t403.soul合并.test.mjs`：personaPrefix 已按主人 2026-11-23 指令删除、hippocampus 已退役；文件整篇锁的是旧结构。现行不变量由 契约检查.mjs 与 模板 自检.sh 覆盖。
- `t404.记忆注入.test.mjs`：锁的是 大肥鱼「梗知识」16 条搬到哈基米「圈子黑话.json」的内容迁移；黑话本现在是各实例自己的可编辑内容，新记忆走 dsh-mnemonic。
- `t405.工具用量.test.mjs`：要求 SOUL.md 写 qq_recall/qq_work 指引；qq_recall 依赖的 rofm 已退役，人设也不再写工具名做引导。
- `t407.内心怕的.test.mjs`：断言实例 记忆/想要.json 里有两条例时期遗留的「怕的」；哈基米按自己创建日重建过，不抄别家数据。
- `t438.注入指向.test.mjs`：依赖 dsh-bili-humanism 的 human-world.md；该人格学习默认关闭、从未生成文件，冲浪养分槽本就为空。
- `t519.图片图鉴.test.mjs`：断言实例图鉴真档回填名字数量；属于实例内容数据，不是通用机制。
- `t575.P0对接.test.mjs`：要求 deliver.js 调 mem-short 短期记忆；该机制随 rofm/hippocampus 退役，现由 dsh-mnemonic 承担。
- `t630.hippocampus只读工具.test.mjs`：dsh-hippocampus 已于 2026-11-25 停用并归档到 /data/plugin-archive/2026-11-25-retired-memory/。
- `t663.回忆解耦开关.test.mjs`：锁 poll.js 的 慢变段/自动回忆条 拆分；回忆已由 dsh-mnemonic 独立注入，旧入口不存在。

## 同一批修好、仍保留在 测试/ 的

- t352：状态注入锚点改到现行标签（说话的样/此刻的感受），受众隔离断言不变。
- t353：模块沙盒改成整树镜像（修子目录 import），睡眠用例恢复；D1/ROFM 两条旧机制用 skip 注明退役；穿衣夹具改用现役「鲸鱼发卡」。
- t428：qq_self 断言改读 tool-interact.js（模块拆分后位置）。
- t439：qq_remember 描述措辞更新（只记对方的事 / 都不记这儿）。
- t440：SOUL.md 补回「群里别人说的话不外传、不截图、不复述」。
- t643：关系档断言改认 `${QQ_WS}` 动态 import。
- t654：qq_recall 描述断言更新，并钉住不得再指向 rofm/hippocampus；recall.js 描述已同步删除退役来源。
- t676：纪念日事实句改在 记忆入口.mjs 校验。
