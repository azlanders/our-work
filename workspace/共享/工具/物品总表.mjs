#!/usr/bin/env node
// 物品总表.mjs —— 兼容壳（2026-11-16 P1）
//
// 旧入口曾经自己维护第二套扁平化逻辑，已经和 表.mjs 分叉：
//   node 表.mjs        → 85 样
//   node 物品总表.mjs  → 88 样，随后在 类[v.类别] 崩掉
// 现在只做一件事：命令行调用时原样转给 表.mjs。
// 新代码优先 import { 查, 所有 } from './表.mjs'；本文件只给旧调用兜底。
// 批次578：表.mjs 入口判断改成 basename 精确匹配后，这里恢复 export * ——
// 旧代码 import 本文件也能拿到同一份 查/所有/分组/缺项，不再两套口径。
export * from './表.mjs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const 是主 = process.argv[1] && process.argv[1].endsWith('物品总表.mjs')
if (是主) {
  let args = process.argv.slice(2).map((x) => (x === '--看' ? '--查' : x))
  // 旧 --查 不带名字时是汇总；新 表.mjs 的 --查 需要名字，这里补回旧语义。
  if (args.length === 1 && args[0] === '--查') args = []
  const 出 = execFileSync(process.execPath, [
    fileURLToPath(new URL('./表.mjs', import.meta.url)),
    ...args,
  ], { encoding: 'utf8' })
  process.stdout.write(出)
}
