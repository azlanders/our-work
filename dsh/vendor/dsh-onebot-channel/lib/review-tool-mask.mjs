export const REVIEW_LOOKUP = 'bili_humanism_lookup_review'

export function 限制审定查询(ctx, agent, tools, names, ownerOnly, onError) {
  const allowed = ownerOnly ? names : names.filter((name) => name !== REVIEW_LOOKUP)
  let signature = null
  let current
  let stopped = false
  let pending = false
  const update = () => {
    if (stopped) return
    const known = tools.view(agent).restrictableNames
    const next = allowed.filter((name) => known.has(name))
    const key = JSON.stringify(next)
    if (key === signature) return
    const previous = current
    current = tools.restrict({ allow: next })
    signature = key
    if (previous) Promise.resolve().then(() => previous()).catch(onError)
  }
  update()
  const off = ctx.on('tools/change', () => {
    if (stopped || pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      try { update() } catch (error) { onError(error) }
    })
  })
  const close = () => {
    if (stopped) return
    stopped = true
    off()
    return current?.()
  }
  ctx.effect(() => close)
  agent.ctx.effect(() => close)
}
