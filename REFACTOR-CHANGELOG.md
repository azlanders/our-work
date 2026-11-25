# azlanders/our-work Wave 1–3 重构变更说明

本压缩包采用与仓库一致的相对目录结构，可直接解压覆盖到仓库根目录后用 `git diff` 逐项审阅并执行 `bash 自检.sh` 验证。

## 变更文件清单

1. **新增 `scripts/tpl_engine.py`**（统一模板引擎，零第三方依赖）
   - 收口所有 `.env` 解析、正向渲染（单次正则替换，无 `sed` 分隔符/转义风险）、安全反向占位符化（`PORT_KEYS` 仅在 `>= 1024` 时替换，彻底修复 `GATEWAY_PORT=0` 把全库 `0` 替换成 `{{GATEWAY_PORT}}` 的 P0 缺陷）、`pid + random` 原子写盘与占位符校验。
2. **重构 `clean-persona.py`**
   - 用单次正则并行扫描修复 `1000000001 <-> 1000000002` 互相抵消的 P0 Bug；新增 `--dry` 零写入支持；去除硬编码 `/data/bot-template/workspace`；异常文件显式输出到 stderr。
3. **重构 `同步dsh.sh` 与 `推dsh.sh`**
   - 统一调用 `scripts/tpl_engine.py`；修复 `--dry` 仍建目录的违规；移除备份 `2>/dev/null || true` 静默吞错。
4. **重构 `同步一圈.sh`**
   - 将 `--dry` 透传至全部 4 个步骤，兑现零写入承诺；用 `env -i` 子 shell 隔离各实例 `DSH_ROOT` 防止跨 bot 串写；增加空目录 `nullglob` 保护。
5. **重构 `安装新bot.sh`**
   - 用 `scripts/tpl_engine.py` 取代脆弱的 `sed` 与内联 Python 拼接；修复 `cp -a vendor` 嵌套 `vendor/vendor` 问题；使用 `$SVC_BOT` / `$SVC_WATCHDOG` 取代硬编码服务名。
6. **重构 `自检.sh`**
   - 改为逐匹配项剔除允许常量后再检泄露，修复同行漏检；通过 `tpl_engine.py` 实测渲染 `bridge/` 与 `dsh/`（含 `|`、`&` 特殊字符）；`node` 缺失时报错而非静默跳过；接入 `tests/test-tpl-engine.py`。
7. **重构 `bridge/watchdog.sh.tpl`**
   - 参数化协议端冷却锁路径与服务名；修复 `$lastErr` 为空时 GNU `date -d ""` 误返回当天零点的缺陷；增加 `curl -fsS` 与数字校验；改为重启成功后再写冷却时间戳。
8. **重构 `patches/应用全部.sh`**
   - 用 `mktemp` + `trap` 取代固定 `/tmp/_patch_*.log`；`--dry` 执行真实 `patch --dry-run` 且不建备份目录；任一补丁失败立即返回非零退出码。
9. **重构 `workspace/共享/工具/_状态.mjs` 与 `主动戳.mjs`**
   - `_状态.mjs` 区分 `ENOENT` 与 JSON 损坏，坏文件自动备份为 `.corrupt-<ts>` 并在 `saveState` 合并时阻断覆盖。
   - `主动戳.mjs` 清除 `B:/肥鱼/` 硬编码路径、硬编码群号 `1051483012` 与未使用的 `writeFileSync`。
10. **修复 `dsh/vendor/dsh-live-compact/plan.js`**
    - 修复 `expandBack` 在 `stopAt = crossUserFloor - 1 < 0` 时索引 `items[-1]` 触发 `TypeError` 崩溃的边界缺陷（由新增单测实时捕获）。
11. **增强 `tests/t-cut-drain.mjs` 并新增 `tests/test-tpl-engine.py`**
    - 补充工具轮配对完整性断言，并覆盖全部 P0/P1 回归测试。

## 应用与验证步骤

```bash
# 1. 在仓库根目录解压覆盖（建议先 git status 确认工作区干净）
unzip -o our-work-refactor-wave1-3.zip -d .
chmod +x scripts/tpl_engine.py clean-persona.py 同步dsh.sh 推dsh.sh 同步一圈.sh 安装新bot.sh 自检.sh patches/应用全部.sh tests/test-tpl-engine.py

# 2. 审阅改动并运行完整自检
git diff --stat
bash 自检.sh
```
