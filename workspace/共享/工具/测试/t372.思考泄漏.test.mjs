import { 疑似思考泄漏 as 判 } from '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/outbound.js'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 漏 = [
  ['漏1', 'He\'s calling me, "喂喂喂". My previous two turns produced nothing. I need to actually send now. Send a voice message to test the new voice + a short text. Let me call qq_say_voice and qq_send together. Voice text: "在在在，我在……唱，这声音是我吗，听着有点不像我，主人你换的？" Keep under 60s, fine. Then a text: "刚才楞神了，不是故意不理你" — actually don\'t over-explain. Just: "在的，刚迷糊过去了"'],
  ['漏2', 'text. Let me call qq_say_voice and qq_send together. Voice text: "在在在，我在……唱，这声音是我吗，听着有点不像我，主人你换的？" Keep under 60s, fine.'],
  ['漏3', 'The voice was sent, memory_judge done. Nothing pending. Call qq_pass.The voice was sent, memory_judge done. Nothing pending. Call qq_pass.'],
  ['漏4', 'I need to figure out what "这东西" refers to. Let me check message history quickly before replying to him.'],
]
const 正常 = [
  ['短句', '在的，刚迷糊过去了'],
  ['语气词', '嘿嘿，你猜~'],
  ['日常', '我刚从楼下上来，顺手给你带了杯热豆浆。'],
  ['疑问', '你看外面下雨了，伞带了吗？'],
  ['列工具', '我能用的有 qq_send 发消息、qq_photo 拍照、qq_sleep 睡觉这些，你要哪个？'],
  ['汇报1', '记了三条：\n\n- 更正了「随口编数字」那条，把今天说的「三分钟多点」补进去，并写上实际查到是 21 秒。\n- 新增：QQ 卡片消息到我这儿只剩 [json 片段]，改成读 message 段。\n- `qq_send` 返回值和实际投递对不上，记在 lesson 里了。'],
  ['汇报2', '图发出去了 ✅ ——不过这一路踩了不少坑，记录如下：\n\n- **webp 不行**：QQ 直接拒（`EventChecker Failed`）\n- 转成 png 之后 2880×2880 太大，压到 1200 才过。'],
  ['汇报3', '清好了，只留三个：\n\n| 文件 | 大小 |\n|---|---|\n| [BV1nLxk6WEed-720p.mp4](<{{BOT_ROOT}}/缓存>) | 12.3 MB |\n| [BV1Y8tpzuEHL.mp4](<{{BOT_ROOT}}/缓存>) | 8.8 MB |'],
  ['中英混', '我看了下那个 Python 的文档，里面说 asyncio 的 event loop 要注意不能阻塞，不然整个协程队列都卡住了。'],
  ['英文歌', 'OK 好的，没问题，那我先睡了'],
]
let 错 = 0
for (const [n, t] of 漏) {
  const r = 判(t)
  console.log(`${n}：${r ? '拦住' : '★漏过'}  ${t.slice(0, 40)}`)
  if (!r) 错++
}
for (const [n, t] of 正常) {
  const r = 判(t)
  console.log(`正常/${n}：${r ? '★误伤' : '放行'}  ${t.replace(/\n/g, ' ').slice(0, 40)}`)
  if (r) 错++
}
console.log(`\n${错 === 0 ? '全对' : '错 ' + 错 + ' 条'}`)
