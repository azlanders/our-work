export function 有效感受(text) {
  const rows = String(text || '').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter((row) => row && typeof row === 'object')
  const ids = new Set(rows.filter((row) => row.chatKey && row.id).map((row) => `${row.chatKey}\0${row.id}`))
  const corrected = new Set(rows.filter((row) => row.chatKey && row.corrects)
    .map((row) => `${row.chatKey}\0${row.corrects}`))
  return rows.filter((row) => !(row.chatKey && row.corrects && row.kind === '想岔了')
    && !(row.chatKey && row.id && ids.has(`${row.chatKey}\0${row.id}`) && corrected.has(`${row.chatKey}\0${row.id}`)))
}
