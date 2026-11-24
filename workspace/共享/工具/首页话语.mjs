export function 内心短句(原文) {
  const 状态 = String(原文 ?? '').trim().match(/^精力\s+(\d{1,3})\/100[；;]\s*困意\s+(\d{1,3})\/100/)
  if (!状态) return ''
  const 精力 = Number(状态[1]), 困意 = Number(状态[2])
  if (困意 >= 75) return '眼皮都快撑不住啦，想眯一会儿。'
  if (精力 < 30) return '这会儿没什么力气，想歇一下。'
  if (困意 >= 45) return '唔，有一点犯困。'
  if (精力 >= 60) return '现在精神还挺好。'
  return '我这会儿还好。'
}

export function 留话摘句(条目, 日板 = []) {
  const 历史 = (Array.isArray(条目) ? 条目 : []).filter(项 =>
    项?.谁 === '她' && 项.不投递 !== true && !['日报', '早安'].includes(项.kind)
    && !['重复', '过期'].includes(项.寄?.skip))
  const 回复 = 日板.flatMap(板 => 板.notes.filter(签 => 签.by === '主人').flatMap(签 =>
    (Array.isArray(签.comments) ? 签.comments : []).filter(评 => 评?.by === '{{ALT_BOT_DISPLAY}}')
      .map(评 => ({ at: 评.at, 话: 评.text, 来源: '留言板回复', 日期: 板.date }))))
  return [...历史, ...回复].filter(项 => typeof 项.话 === 'string' && 项.话.trim())
    .map(项 => ({ at: String(项.at || '').slice(0, 16), 话: 项.话.trim().slice(0, 600).toWellFormed(),
      ...(项.来源 ? { 来源: 项.来源, 日期: 项.日期 } : {}) }))
    .sort((前, 后) => 后.at.localeCompare(前.at)).slice(0, 8)
}
