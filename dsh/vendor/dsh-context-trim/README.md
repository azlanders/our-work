# dsh-context-trim

> 为真实拟人化 QQ 机器人环境量身打造的 **上下文无损瘦身与增量差分插件**。

---

## 核心设计与解决的问题

本插件结合了社区优秀思路（`rwbymoe/dsh-context-diff` 的 Myers 行级差分算法与 `HaireXe-fish-economy` 的工具结果入口裁剪复利思想），**彻底剔除了原民科方案中会导致 QQ 机器人哑巴的 Tool Gate 机制与引起并发锁冲突的强制压缩**，具备以下三大核心能力：

1. **工具结果入口截断（`tools/post-execute`）**：
   * 工具（如 `bash`、`read`、状态同步）返回长文本超过阈值（默认 2500 字）时自动掐头去尾，保留头部 60% 与尾部 40% 结构，中间插入截断提示。
   * **复利省 Token**：截断发生在内容写入 Session 之前，从根源上阻止动辄数万字符的工具输出在后续所有轮次被反复作为历史重发。
   * **多模态安全**：仅针对文本块截断，图片、音频与自定义结构块 100% 原始放行。
2. **指令文件 Myers 增量差分（`llm/stream`）**：
   * 当规则文件（如 `AGENTS.md`）发生热更新时，仅向下游模型发送行级 diff 锚点，不再全量堆叠重复全文。
   * 严格包含 **换行符归一化**（CRLF vs LF 防穿透）、**收益守卫**（diff 大于原文时自动全量发送）、以及 **Compaction 感知重置**。
3. **QQ 机器人全链路零副作用保证**：
   * **绝对不修改工具名单（No Tool Gate）**：`qq_send`、`qq_photo`、`memory_recall` 等所有拟人化工具 100% 常驻可见，杜绝机器人失语，保护 Prompt Cache 前缀缓存命中率。
   * **不触碰压缩控制器（No Compaction Interference）**：不主动触发 `compactNow`，与外部主干压缩服务（如 `dsh-live-compact`）零并发冲突。
   * **Fail-Open 健壮性**：任何异常静默降级为放行原始请求，不影响正常会话。

---

## 配置示例

在 `cordis.patch.yml` 中配置：

```yaml
- id: dsh-context-trim
  name: dsh-context-trim
  config:
    enabled: true
    maxToolChars: 2500    # 单工具文本输出上限，默认 2500 字
    enableTrim: true      # 开启工具输出截断
    enableDiff: true      # 开启指令行级 Myers 差分
    debug: false          # 调试日志开关
```

---

## 测试验证

全量单元测试覆盖工具截断、非文本保护、Myers 差分、换行符容错、收益守卫与 fail-open 保护：

```bash
node --test test/*.test.mjs
```
