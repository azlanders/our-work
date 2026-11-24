#!/usr/bin/env node
// 静态检查.mjs —— 「引用了没定义的名字」这一类错，上线前拦住（2026-11-12）
//
// 用法：node 静态检查.mjs            有问题退出码 1，没装 eslint 退出码 2
//       node 静态检查.mjs --详情     连干净的文件数也列出来
//
// 为什么要有这个：
//   `node --check` 只查语法。引用一个没定义/没 import 的名字，语法是对的，只有真走到那一行才崩 ——
//   而且这个项目里那一行多半包在 try/catch 里，崩了也没声音。2026-11-12 一次审计查出来的：
//     · 睡眠阶段.mjs  endSleep 里的 stateSnap     → 睡醒结算静默失败两天多（records/欠觉账/补课全停）
//     · 洗澡.mjs      洗完了() 里的 __stSnap      → 下次洗澡必卡死
//     · 自主行动.mjs  疾病 没 import              → 病中倾向三条从没生效
//     · _状态.mjs     existsSync 没 import        → 状态跳变审计一条都写不出来
//     · lib/sessions.js  rememberResumed 作用域   → 死会话恢复路径必抛错
//   另外 自主行动.mjs 两天内因为同一类错在线上崩过 124 次（TDZ 73 次 + 未定义 51 次）。
//   当时 自检 94/94、契约 622/622 全绿 —— 门禁里没有一条管这个。
//
// 只开「走到就崩」的规则，不管风格：规则多了天天红，就没人看了。
// 查的范围：插件 lib/ 顶层 + 本目录顶层的 .mjs/.js（不含 测试/ three/ _归档/）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LINT = process.env.QQ_LINT_DIR || '/root/qq-audit/lint'
const TOOLS = process.env.QQ_LINT_TOOLS || '{{BOT_ROOT}}/共享/工具'
const LIB = process.env.QQ_PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 详情 = process.argv.includes('--详情')

if (!existsSync(join(LINT, 'node_modules/eslint/lib/api.js'))) {
  console.log('  ✗ 静态检查没法跑：' + LINT + ' 里没有 eslint。装法：cd ' + LINT + ' && npm install --ignore-scripts eslint@9 globals')
  process.exit(2)
}
const { ESLint } = await import(pathToFileURL(join(LINT, 'node_modules/eslint/lib/api.js')).href)
const globals = (await import(pathToFileURL(join(LINT, 'node_modules/globals/index.js')).href)).default

const 列 = (dir) => existsSync(dir)
  ? readdirSync(dir).filter((f) => /\.(mjs|js)$/.test(f) && !f.includes('.tmp-')).map((f) => join(dir, f))
  : []
const 文件 = [...列(LIB), ...列(TOOLS)]

const rules = {
  'no-undef': 'error',                 // 没定义 / 没 import
  'no-use-before-define': ['error', { functions: false, classes: false, variables: false }], // 同一作用域里先用后声明（TDZ）
  'no-const-assign': 'error',
  'no-import-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-func-assign': 'error',
  'no-obj-calls': 'error',
  'no-class-assign': 'error',
  'no-this-before-super': 'error',
  'constructor-super': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-unsafe-negation': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-redeclare': 'error',
}
const eslint = new ESLint({
  cwd: '/',
  overrideConfigFile: true,
  errorOnUnmatchedPattern: false,
  overrideConfig: [
    { ignores: ['!**/node_modules/'] }, // 插件就在 node_modules 里，默认会被整个跳过
    {
      files: ['**/*.js', '**/*.mjs'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      rules,
    },
    // client.js 是跑在浏览器里的那一半，window/document 是它的环境，不是没定义
    { files: ['**/client.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  ],
})

const 结果 = await eslint.lintFiles(文件)
const 问题 = []
for (const r of 结果) {
  let 源 = null
  for (const m of r.messages) {
    if (m.severity !== 2 && !m.fatal) continue
    if (m.ruleId === 'no-use-before-define') {
      // import 是提升的，写在文件中间也不会 TDZ；这条规则不认这个，这里放过
      const 名 = (/^'(.+?)' was used/.exec(m.message) || [])[1]
      if (名) {
        if (源 === null) { try { 源 = readFileSync(r.filePath, 'utf8') } catch { 源 = '' } }
        const 转 = 名.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp('import\\s[^;\'"]*(^|[\\s,{])' + 转 + '([\\s,}]|$)[^;\'"]*from\\s').test(源)) continue
      }
    }
    问题.push(r.filePath.replace(TOOLS + '/', '').replace(LIB + '/', 'lib/') + ':' + m.line + ' ' + (m.fatal ? '解析失败' : m.ruleId) + ' ' + m.message)
  }
}
for (const x of 问题) console.log('  ✗ ' + x)
if (详情) console.log('  查了 ' + 文件.length + ' 个文件（lib ' + 列(LIB).length + ' / 工具 ' + 列(TOOLS).length + '）')
console.log('静态检查：' + 文件.length + ' 个文件，' + 问题.length + ' 处会崩的引用')
process.exit(问题.length ? 1 : 0)
