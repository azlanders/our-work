# azlanders/our-work Wave 3–4 续篇重构说明

本压缩包承接 `our-work-refactor-wave1-3.zip`，完成剩余根目录同步脚本的模板引擎收口与补丁层原子写加固。

## 变更文件清单

1. **重构 `推给所有实例.sh`**
   - 彻底移除 32 个位置参数传参，改由 `scripts/tpl_engine.py` 统一加载变量与渲染。
   - 修复 `--dry` 假报告问题：先计算渲染结果并与目标文件比对，仅输出真正有差异的文件；非 dry-run 跳过未变文件保留 mtime，变更文件走原子写盘；移除 `tar ... 2>/dev/null || true` 吞错。
2. **重构 `同步模板.sh`**
   - 修复 `--dry` 模式下仍调用 `os.makedirs` 建目录的违规，做到严格零写入。
   - 直接导入 `clean-persona.py` 的 `clean_text`（淘汰脆弱的 `ast.parse` 源码解析），写入模板时同步完成脱敏与原子落盘；为 `--name`/`--vars`/`EXTRA_SUBS` 增加缺参保护。
3. **加固 `patches/patch_llm_retry.py`、`patches/dsh-rofm-compact-desc.py`、`patches/dsh-onebot-channel-quiet-hours.py`**
   - 全部改为 `pid + random` 原子写盘并支持 `--dry`。
   - `patch_llm_retry.py` 改为自动调用 `npm root -g` 定位路径，移除 `node-v22.23.4` 硬编码。
   - `dsh-rofm-compact-desc.py` 增加双锚点强校验，杜绝仅替换引用未注入定义引发的 `ReferenceError`。
4. **新增 `patches/manifest.json`**
   - 声明式登记有效宿主/vendor 补丁，并明确标注 `patch_tool_whitelist.py`（死脚本）、`portable_onebot.py`、`fix_portable.py` 为待清理/废弃项。
5. **扩充 `tests/test-tpl-engine.py`（5 项 → 8 项）**
   - 新增 `同步模板.sh --dry` 零写入测试、`dsh-rofm-compact-desc.py` 双锚点阻断测试、`patch_llm_retry.py` 幂等与 dry-run 测试。

## 应用与验证步骤

```bash
# 建议先应用 Wave 1–3 包，再解压本包覆盖：
unzip -o our-work-refactor-wave4.zip -d .
chmod +x 推给所有实例.sh 同步模板.sh patches/patch_llm_retry.py patches/dsh-rofm-compact-desc.py patches/dsh-onebot-channel-quiet-hours.py tests/test-tpl-engine.py
bash 自检.sh
```
