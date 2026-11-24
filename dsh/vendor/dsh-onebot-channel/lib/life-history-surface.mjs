import { randomUUID } from 'node:crypto'

const 旧事前缀 = /^((?:\[本聊天的旧感受；[^\n]+\]\n(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\n]+\n){1,2})?)\[旧事素材\] [^\n]+\n(?:- (?:手账|日记|梦|链|冬冰|冬冰进度) · \d{4}-\d{2}-\d{2}：[^\n]+ \[旧事-[0-9a-f]{16}\]\n){1,3}(?=（可观测运行信息：本批投递时间 )/
const 宿主来信种类 = new Set(['runtime-context', 'compact-checkpoint', 'repeat-tool-reminder', 'time-context', 'skill-catalog'])

export function stripLifeRecallContent({ source, content }) {
  if (source?.kind !== 'user' || source.qq?.chatKind !== 'private' || source.qq.lifeHit !== true) return content
  const [first, ...rest] = content
  if (first?.type !== 'text') return content
  const text = first.text.replace(旧事前缀, '$1')
  return text === first.text ? content : [{ ...first, text }, ...rest]
}

export function registerLifeHistorySurface(ctx) {
  ctx.on('agent/pre-step', async ({ agent, step, messages }, next) => {
    if (step === 1 || messages.some(message => !宿主来信种类.has(message.source?.kind))) {
      const { session } = agent
      for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq)
        if (event.type !== 'user/message') continue
        const { data: message } = event
        const content = stripLifeRecallContent(message)
        if (content === message.content) continue
        const { source } = message
        session.append('user/message', {
          ...message,
          id: randomUUID(),
          source: { ...source, qq: { ...source.qq, lifeHit: false } },
          content,
        }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
    }
    return next()
  }, { prepend: true })
}
