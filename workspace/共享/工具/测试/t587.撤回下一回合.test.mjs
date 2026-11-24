// 批次587：precheck 拦下的消息必须能从 inbox.next-turn 撤回，不能下一回合再投一遍。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 撤回下一回合 } = await import(LIB + '/tool.js')
const {
  rememberStagedInbox, takeStagedInbox, markConsumedIncoming, allConsumedIncoming
} = await import(LIB + '/rhythm.js')

test('R1 QQ 消息 → inbox 消息 id 只能取一次', () => {
  rememberStagedInbox('private:701', [42], 'msg-a')
  assert.equal(takeStagedInbox('private:701', 42), 'msg-a')
  assert.equal(takeStagedInbox('private:701', 42), '')
})

test('R2 precheck 撤回 next-turn 里对应的那条', () => {
  const removed = []
  const exec = {
    agent: {
      inbox: {
        nextTurn: [{ id: 'msg-b' }, { id: 'msg-c' }],
        remove(id) { removed.push(id); return true }
      }
    }
  }
  rememberStagedInbox('private:702', [43], 'msg-b')
  assert.equal(撤回下一回合(exec, 'private:702', [43]), 1)
  assert.deepEqual(removed, ['msg-b'])
})

test('R3 已经被 claim 的消息不误删', () => {
  let called = 0
  const exec = {
    agent: {
      inbox: {
        nextTurn: [],
        remove() { called += 1; return true }
      }
    }
  }
  rememberStagedInbox('private:703', [44], 'msg-d')
  assert.equal(撤回下一回合(exec, 'private:703', [44]), 0)
  assert.equal(called, 0)
})

test('R4 没有 inbox 时安全返回 0', () => {
  assert.equal(撤回下一回合(null, 'private:704', [45]), 0)
  assert.equal(撤回下一回合({ agent: {} }, 'private:704', [45]), 0)
})

test('R5 consumed 标记按 peer 隔离', () => {
  markConsumedIncoming('private:705', [46, 47])
  assert.equal(allConsumedIncoming('private:705', [46, 47]), true)
  assert.equal(allConsumedIncoming('private:705', [46, 48]), false)
  assert.equal(allConsumedIncoming('private:706', [46]), false)
  assert.equal(allConsumedIncoming('private:705', []), false)
})
