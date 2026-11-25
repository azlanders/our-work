// P1 迁移兼容入口：真源已迁至 ./核心/账本.mjs（保留契约检查所需的具名出口）
import { 一笔 as _一笔, 汇总 as _汇总, 某天 as _某天 } from './核心/账本.mjs'
export * from './核心/账本.mjs'
export function 一笔(...args) { return _一笔(...args) }
export function 汇总(...args) { return _汇总(...args) }
export function 某天(...args) { return _某天(...args) }
