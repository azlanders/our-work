#!/usr/bin/env python3
"""白名单容错补丁（2026-11-24）

问题：config.工具白名单 里只要有一个宿主不认识的名字（video_zoom 是 agent 作用域工具，
不在 restrict 的 global 名单里），tools.restrict() 就整条抛错，结果一个工具都不裁 ——
每轮 107 个工具 schema、59k 字符全下发。

修法：先取 tools.view(agent.ctx).restrictableNames，把名单过滤成宿主认识的子集，
缺的名字只记日志；可用的非空才 restrict。

用法：
    python3 patch_tool_whitelist.py <profile>/node_modules/dsh-onebot-channel/lib/index.js [...]
    然后 node --check 每个文件，重启 bot。
"""
import pathlib, shutil, datetime, sys
old = '''        const 白名单 = Array.isArray(config.工具白名单) ? config.工具白名单 : []
        if (白名单.length > 0) {
          try {
            const t = serviceOf(agent.ctx, 'tools')
            if (t && typeof t.restrict === 'function') {
              if (config.enableKnowledgeReviewLookup === true && 白名单.includes(REVIEW_LOOKUP)) {
                const 主人路由 = 主人专属会话({ kind: 'private', id: String(config.ownerUin ?? config.peerUin ?? '') }, config)
                限制审定查询(ctx, agent, t, 白名单, 主人路由 !== '' && 主人路由 === agent.session?.id,
                  (error) => note('tools', `审定工具名单刷新失败：${error instanceof Error ? error.message : String(error)}`))
              } else t.restrict({ allow: 白名单 })
              note('tools', `工具白名单已生效：${白名单.length} 个（其余不下发）`)
            } else {
              note('tools', 'agent.ctx.tools.restrict 不可用，跳过（行为不变）')
            }
          } catch (e) {
            note('tools', '工具限制失败（行为不变）：' + (e instanceof Error ? e.message : String(e)))
          }
        }'''
new = '''        const 白名单 = Array.isArray(config.工具白名单) ? config.工具白名单 : []
        if (白名单.length > 0) {
          try {
            const t = serviceOf(agent.ctx, 'tools')
            if (t && typeof t.restrict === 'function') {
              // TOOL_KNOWN 2026-11-24：名单里混进一个宿主不存在的工具名（video_zoom），restrict() 整条抛错，
              // 结果一个工具都没裁 —— 每轮 107 个 schema、59k 字符全下发。先按宿主已知名单过滤，缺的只记日志。
              let 可用 = 白名单
              try {
                const 已知 = t.view?.(agent.ctx)?.restrictableNames
                if (已知 && typeof 已知.has === 'function') {
                  const 缺失 = 白名单.filter((n) => !已知.has(n))
                  可用 = 白名单.filter((n) => 已知.has(n))
                  if (缺失.length > 0) note('tools', `白名单剔除宿主未知工具：${缺失.join('、')}`)
                }
              } catch { /* view 拿不到就按原名单试，失败有下面的兜底日志 */ }
              if (可用.length === 0) {
                note('tools', '白名单没有一个命中宿主工具，跳过限制（行为不变）')
              } else if (config.enableKnowledgeReviewLookup === true && 可用.includes(REVIEW_LOOKUP)) {
                const 主人路由 = 主人专属会话({ kind: 'private', id: String(config.ownerUin ?? config.peerUin ?? '') }, config)
                限制审定查询(ctx, agent, t, 可用, 主人路由 !== '' && 主人路由 === agent.session?.id,
                  (error) => note('tools', `审定工具名单刷新失败：${error instanceof Error ? error.message : String(error)}`))
              } else {
                t.restrict({ allow: 可用 })
                note('tools', `工具白名单已生效：${可用.length} 个（其余不下发）`)
              }
            } else {
              note('tools', 'agent.ctx.tools.restrict 不可用，跳过（行为不变）')
            }
          } catch (e) {
            note('tools', '工具限制失败（行为不变）：' + (e instanceof Error ? e.message : String(e)))
          }
        }'''
