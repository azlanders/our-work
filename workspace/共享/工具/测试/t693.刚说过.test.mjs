import test from 'node:test'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 批次 693：私聊原来没有「我刚说过什么」，80 秒里同一件事能说三遍。
// 这一条锁两件事：[你刚说过] 进了私聊正文；重复提示只认「中间那截事实几乎不动」的句子。

process.env.QUIET_NOTE = '1'

const 测试目录 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(测试目录, '..')
const 线上lib = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/profiles/web/node_modules/dsh-onebot-channel/lib'
const LIB = process.env.QQ_LIB_DIR || (existsSync(join(工具, '..', 'plugin-lib')) ? join(工具, '..', 'plugin-lib') : 线上lib)

const { 重复提示Of, 刚说过段, noteSaid } = await import(pathToFileURL(join(LIB, 'recent-say.js')).href)

const 点 = (hhmmss) => Date.parse(`2026-11-16T${hhmmss}+08:00`)

test('K1 真实复读那两句能被认出来', () => {
  const s = 重复提示Of([
    { at: 点('23:23:44'), text: '我窗户外头这会儿二十度，晴，能看见星星' },
    { at: 点('23:23:50'), text: '我这边窗外这会儿二十度，星星挺亮' }
  ])
  assert.match(s, /\[同一件事\]/)
  assert.match(s, /23:23/)
})

test('K2 近义但不重合的句子不算重复', () => {
  const s = 重复提示Of([
    { at: 点('23:22:28'), text: '周三才往下掉，周四直接二十二，那时候才该翻外套' },
    { at: 点('23:22:36'), text: '十多度那真是要命，出门风一吹尾巴都僵了' },
    { at: 点('23:23:56'), text: '二十几度不冷不热，正适合干活或者躺着' }
  ])
  assert.equal(s, '')
})

test('K3 少于两条不给提示', () => {
  assert.equal(重复提示Of([]), '')
  assert.equal(重复提示Of([{ at: 点('23:23:50'), text: '我这边二十度' }]), '')
})

test('K4 刚说过段把最近的几句拼进私聊正文，同一件事另起一段', () => {
  const 私 = { kind: 'private', id: '{{OWNER_UIN}}' }
  noteSaid(私, '刚划到一个标题写着「{{BOT_DISPLAY}}捅穿AZ3」，我在想是不是又有谁拿我名字乱写')
  noteSaid(私, '我窗户外头这会儿二十度，晴，能看见星星')
  noteSaid(私, '我这边窗外这会儿二十度，星星挺亮')
  const s = 刚说过段(私, 5)
  assert.match(s, /\[你刚说过\]/)
  assert.match(s, /秒前：/)
  assert.match(s, /\[同一件事\]/)
})
