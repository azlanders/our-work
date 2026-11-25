- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
- id: approval
  name: "@deepseek-ai/dsh-user-approval"
  config:
    policy: never
- id: tool-web
  name: "@deepseek-ai/dsh-tool-web"
  disabled: false
  config:
    fetch: true
    searchTimeoutMs: 60000
- id: tool-bash
  name: "@deepseek-ai/dsh-tool-bash"
  disabled: false

- id: system-prompt
  name: "@deepseek-ai/dsh-system-prompt"
  config: {}


- id: bili-humanism
  name: "dsh-bili-humanism"
  config:
    dataDir: {{DSH_ROOT}}/bili-humanism
    credentialPath: {{DSH_ROOT}}/bili-humanism/credential.json
    enableDailyFetching: true
    dailyFetchLimit: 1

- id: dsh-video-storyboard
  name: "dsh-video-storyboard"
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: compaction-basic
  config:
    thresholdRatio: 0.15
    retainTokens: 8192
    compactionRetries: 1
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    retryPolicy:
      mode: normal
      maxRetries: 1
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 10000
        jitterRatio: 0.2

- id: deliverable-file-references
  disabled: true

- id: harness-dev-context
  disabled: true

- id: tool-jobs
  disabled: true

# 图片瘦身 2026-11-24：Gemini web 按 base64 字数算 token，一张 1.5MB 分镜图 = 200 万字 = 150 万入。
# 压到 ~1024px / 100KB，观感够用，费用掉两个数量级。
- id: attachment-local
  config:
    normalizedImageMaxPixels: 1048576
    normalizedImageMaxBytes: 102400

# 2026-11-24 压缩收线：默认 32000 会把 31k 上下文判定为「不用切」，
# 结果每轮固定 3.1 万 token。降到 14000，配合 minTokens 20000 每轮本地切。
- id: compaction-spine
  config:
    minTokens: 13000
    keepRoundTokens: 9000
    chunkMin: 1000

# 2026-11-24：回忆块对齐基准测试配置（4 条 / 每条 200 字 / 整块 900 字）。
# 生产默认 3/120/600 偏紧，时间题和多方线索题容易缺上下文。
- id: dsh-mnemonic
  config:
    injectChars: 900
    itemChars: 200
    limit: 4

# 2026-11-25：剪工具结果的活交给官方 pruner。
# dsh-context-trim 的 tools/post-execute 参数用错了（waterfall 签名是 exec,result,next，
# 它当成 (event,next) 并调用 next()），trim 与官方重复且每次工具调用都会抛错；
# 它的 llm/stream 差分还会改写指令消息、打断 Prompt Cache 前缀。整体停用。
- id: tool-result-pruner
  disabled: false
- id: dsh-context-trim
  disabled: true
