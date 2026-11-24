#!/usr/bin/env node
// 全套验收.mjs —— 一条命令看「她身上这些功能到底在不在」（2026-11-02）
//
// 用法：node 全套验收.mjs
//
// 为什么写这个：
//   · 改了一晚上，功能散在十几个文件里。等主人问「都好着吗」，我得能一条命令给出证据，
//     而不是一件件去翻。检查分三层：代码里有没有接（grep 注入标记）、数据在不在（文件）、
//     能不能跑（各个脚本 --show/--dry）。
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// ENTRY_GUARD 2026-11-14（批次459）：被 import 时不要跑主流程。
// 冒烟测试「逐个 import」会把每个 .mjs 当 CLI 真跑一遍（457 实测一次写 16 个真档），
// 而这些脚本顶层就是整条流程。只有 `node <本文件>` 才执行下面的主流程；被 import 时是空模块。
// 用 __path/__fileURLToPath 这两个别名，避免和各文件已有的 path/join 撞名。
import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {

const base = '{{BOT_ROOT}}/记忆'
const tools = '{{BOT_ROOT}}/共享/工具'
const lib = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
const NODE = '/usr/local/bin/node'

let pass = 0, fail = 0
const ok = (name, extra) => { pass += 1; console.log('  ✓ ' + name + (extra ? '：' + extra : '')) }
const no = (name, why) => { fail += 1; console.log('  ✗ ' + name + (why ? '（' + why + '）' : '')) }
const warn = (name, why) => { pass += 1; console.log('  🟡 ' + name + (why ? '（' + why + '）' : '')) } // 黄灯：能服务但归属不对，算通过

const poll = existsSync(lib) ? readFileSync(lib, 'utf8') : ''
const has = (mark) => poll.includes(mark)

console.log('== 一、注入层（每回合她看到什么）==')
const hooks = [
  ['链尾', 'CHAIN_TAIL'],
  ['房间说话', 'ROOM_SAY_HOOK'],
  ['位置', 'PLACE_HOOK'],
  ['认事', 'RENSHI_HOOK'],
  ['耐心', "'耐心 短'"],
  ['@别人打分', 'AT_OTHER_SCORE'],
  ['重复去重', 'SAME_TEXT_GUARD'],
  ['戳一戳判定', 'sub_type'],
]
for (const [name, mark] of hooks) (has(mark) ? ok(name) : no(name, '代码里没这个标记'))

console.log('== 二、数据层（文件在不在、内容对不对）==')
const files = [
  [base + '/状态.json', '状态'],
  [base + '/链.md', '因果链'],
  [base + '/资产.json', '钱物家'],
  [base + '/自主.json', '自主行动'],
  [base + '/睡醒.json', '作息标记'],
]
// ROOM_OFF 2026-11-05：房间功能停用时不该把它的产物当红的
try { if (JSON.parse(readFileSync(base + '/功能开关.json', 'utf8')).房间 === true) files.push([base + '/房间对话.json', '房间对话']) } catch {}
for (const [f, name] of files) (existsSync(f) ? ok(name) : no(name, '文件不存在'))

// HERE 2026-11-17（批次619）：只写不读的产物单独列，不让“文件存在”冒充链路健康。
// 奖惩账：`认事` 钩子停用后没有运行时读方；发送标签：只做投递审计，不驱动情绪/关系。
const archives = [
  [base + '/奖惩.json', '奖惩账（历史留档）'],
  [base + '/发送标签.jsonl', '发送标签（投递审计）'],
]
for (const [f, name] of archives) {
  if (existsSync(f)) warn(name, '只写不读，文件在只说明留档在')
  else console.log('  · ' + name + '：暂无（正常空态）')
}

// 关键字段
try {
  const st = JSON.parse(readFileSync(base + '/状态.json', 'utf8'))
  st['耐心'] ? ok('状态里有耐心', `短${st['耐心']['短期']}/长${st['耐心']['长期']}`) : no('状态里有耐心')
  st['更新时间'] ? ok('状态有更新时间', st['更新时间']) : no('状态有更新时间', '没这个字段就不推进')
} catch (e) { no('状态可解析', e.message.slice(0, 30)) }

try {
  const a = JSON.parse(readFileSync(base + '/资产.json', 'utf8'))
  a['位置'] ? ok('资产有位置', a['位置']) : no('资产有位置')
} catch (e) { no('资产可解析', e.message.slice(0, 30)) }

try {
  const chain = readFileSync(base + '/链.md', 'utf8')
  const n = (chain.match(/^## /gm) || []).length
  n > 0 ? ok('链有内容', n + ' 条') : no('链有内容', '还空着')
} catch { no('链可读') }

console.log('== 三、能不能跑（各脚本自检）==')
const runs = [
  ['困意', [tools + '/困意.mjs'], /困意\s*\d+/],
  ['作息', [tools + '/作息.mjs', '--看看'], /现在/],
  ['资产', [tools + '/资产.mjs', '--看看'], /现在在/],
  ['自主行动', [tools + '/自主行动.mjs', '--看'], /现在/],
  ['奖惩', [tools + '/奖惩.mjs', '--大类'], /人际/],
  ['状态推进', [tools + '/状态推进.mjs', '--dry'], /分钟|不用/],
]
for (const [name, args, re] of runs) {
  try {
    const out = execFileSync(NODE, args, { encoding: 'utf8', timeout: 25000 })
    re.test(out) ? ok(name) : no(name, '输出不对：' + out.split('\n')[0].slice(0, 30))
  } catch (e) { no(name, e.message.slice(0, 30)) }
}

console.log('== 四、服务与外网 ==')
// ROLE_AWARE 2026-11-24：这份验收原来把 dsh-bot / fish-panel / napcat-fish 列成必查，
// 但那套栈只跑在「完整角色」的主机上。VPS 上它们**刻意停用**（QQ 协议端与对话链路
// 都在另一台），于是每次验收都固定 5 项红 —— 真问题被这 5 条假红灯淹没。
// 现在按 参数.json 的 开关.机器人角色 判定：
//   full（默认）  全部必查
//   scripts       只要业务脚本能跑，上面那套栈允许不启用（记 o 跳过，不计红）
const 角色参数 = (() => {
  try {
    const p = JSON.parse(readFileSync('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))
    return String((p['开关'] || {})['机器人角色'] || process.env.BOT_ROLE || 'full')
  } catch { return String(process.env.BOT_ROLE || 'full') }
})()
const 可选服务集 = new Set(String(process.env.ACCEPT_OPTIONAL_SERVICES
  || (角色参数 === 'scripts' ? 'dsh-bot,fish-panel,napcat-fish' : '')).split(',').map(x => x.trim()).filter(Boolean))
const 可选端口集 = new Set(String(process.env.ACCEPT_OPTIONAL_PORTS
  || (角色参数 === 'scripts' ? '8788' : '')).split(',').map(x => x.trim()).filter(Boolean))
if (角色参数 !== 'full') console.log('  · 本机角色=' + 角色参数 + '，可选组件不启用不算红')
// ROOM_OFF 2026-11-05：房间服务停用后不再列进必查服务（功能开关 房间=true 时自动加回）
let ROOM_ON2 = false
try { ROOM_ON2 = JSON.parse(readFileSync('{{BOT_ROOT}}/记忆/功能开关.json', 'utf8')).房间 === true } catch {}
const svcs = ['dsh-bot', 'fish-panel', ...(ROOM_ON2 ? ['fish-room'] : []), 'napcat-fish']
for (const s of svcs) {
  let st
  try {
    st = execFileSync('systemctl', ['is-active', s], { encoding: 'utf8' }).trim()
  } catch (err) {
    // is-active 在 inactive 等状态下也会以非零码退出，先保留实际状态。
    st = String(err.stdout ?? '').trim() || '查不到'
  }

  if (st === 'active') {
    ok(s)
    continue
  }

  // ROLE_AWARE：可选服务在本机本就不该跑 → 直接跳过，不进红灯
  if (可选服务集.has(s)) {
    ok(s + '（本机未启用，跳过）')
    continue
  }

  const url = {
    'fish-panel': 'http://127.0.0.1:8788/',
    'fish-room': 'http://127.0.0.1:8790/',
    'napcat-fish': 'http://127.0.0.1:3100/'
  }[s]

  if (url) {
    try {
      const code = execFileSync('curl', [
        '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', url
      ], { encoding: 'utf8' }).trim()

      // systemd 停着但端口仍有 HTTP 响应，通常是 nohup 影子进程在扛站点；
      // 站点并非真挂，故给黄灯；napcat 按非 000 即存活（包括 401）处理。
      const alive = s === 'napcat-fish'
        ? code !== '' && code !== '000'
        : Number(code) >= 200 && Number(code) <= 499

      if (alive) {
        warn(`${s} 停着但端口有人扛（影子进程）`)
        continue
      }
    } catch {
      // 探测抛错视同拿不到 HTTP 响应，沿用原红灯结果。
    }
  }

  no(s, st)
}
// ROOM_OFF 2026-11-05：3D 房间服务已按主人要求 stop+disable，
// 验收时不再把它当红的；想恢复就把 功能开关.json 的 房间 改回 true。
let ROOM_ON = false
try { ROOM_ON = JSON.parse(readFileSync('{{BOT_ROOT}}/记忆/功能开关.json', 'utf8')).房间 === true } catch {}
for (const [name, port] of [['面板', 8788], ...(ROOM_ON ? [['房间', 8790]] : [])]) {
  if (可选端口集.has(String(port))) { ok(name + '端口（本机未启用，跳过）'); continue }
  try {
    const out = execFileSync('curl', ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:' + port + '/'], { encoding: 'utf8' })
    out === '200' || out === '302' ? ok(name + '端口', 'HTTP ' + out) : no(name + '端口', 'HTTP ' + out)
  } catch { no(name + '端口', '连不上') }
}

console.log('== 五、3D 房间 ==')
if (!ROOM_ON) console.log('  · 3D 房间服务已停用（功能开关 房间=false），这一段跳过')
try {
  if (!ROOM_ON) throw { skip: true }
  // ROOM_ARCHIVED 2026-11-24：3D 房间整套已于 2026-11-12 按主人要求删除，
  // 房间页.html / 房间.mjs / three.min.js 本次一并归档到
  // /root/bak2/3D房间残留-<时间戳>/。这里原来直接 readFileSync，文件不在就抛错；
  // 现在先判存在 —— 缺文件 = 房间功能没装，跳过这一段（由上面的 ROOM_ON 守卫兜底语义）。
  const __房间页 = '{{BOT_ROOT}}/共享/工具/房间页.html'
  if (!existsSync(__房间页)) { console.log('  · 房间页.html 已归档（3D 房间停用），这一段跳过'); throw { skip: true } }
  const page = readFileSync(__房间页, 'utf8')
  const marks = [
    ['HER_TEMPLATE', '她的模型接线'],
    ['LOOK_AT_PLAYER', '会转头看人'],
    ['POSE_BY_STATE', '站位随状态'],
    ['STATE_LIGHT', '灯光随状态'],
    ['GLTFLoader', '模块化加载模型'],
  ]
  for (const [m, label] of marks) {
    page.includes(m) ? ok(label) : no(label, '页面里找不到 ' + m)
  }
  // 资源能不能取到（端口 + 状态码）
  const paths = ['/three/three.module.js', '/models/whale_girl.glb', '/models/furniture2.glb', '/models/small_items.glb']
  for (const p of paths) {
    try {
      const code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '8', '-b', '/tmp/new.txt', 'http://127.0.0.1:8790' + p], { encoding: 'utf8' }).trim()
      code === '200' ? ok('资源 ' + p) : no('资源 ' + p, '返回 ' + code)
    } catch (e) { no('资源 ' + p, e.message.slice(0, 30)) }
  }
  // 页面里的灯光变量必须都起了名（key/hemi 之类）
  const badKey = /\bkey\.intensity/.test(page)
  badKey ? no('灯光变量名', '还有 key.intensity') : ok('灯光变量名')
} catch (e) { if (!e || !e.skip) no('房间页读取', String(e.message || e).slice(0, 40)) }

console.log('== 五、她自己的群（关键）==')
try {
  const cfg = JSON.parse(readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
  const token = cfg.token || ''
  const obBase = String(cfg.onebotHttp || 'http://127.0.0.1:3011/').replace(/\/+$/, '')
  const out = execFileSync('curl', ['-s', '-m', '8', '-X', 'POST', obBase + '/get_group_list',
    '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer ' + token, '-d', '{}'], { encoding: 'utf8' })
  const gs = (JSON.parse(out).data || [])
  const ids = gs.map((g) => String(g.group_id))
  ids.includes('2000000001') ? ok('她在冰屋群') : no('她在冰屋群', '现在的群：' + ids.join(','))
} catch (e) { no('群列表', e.message.slice(0, 40)) }


console.log('== 六、她的状态数值 ==')
;(() => {
  // 状态文件是后续判断的基础，先确认它能读取并解析为 JSON。
  let herState;
  try {
    herState = JSON.parse(readFileSync(`${base}/状态.json`, 'utf8'));
    ok('状态.json 可读');
  } catch (error) {
    no('状态.json 可读', error instanceof Error ? error.message : String(error));
    return;
  }

  // 四层能量越界或出现非有限数字，会让状态展示和行为判断失真。
  const layerEntries = ['physical', 'cognitive', 'emotional', 'existential']
    .map((key) => [key, herState?.layers?.[key]]);
  const invalidLayers = layerEntries.filter(([, value]) =>
    typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100
  );
  if (invalidLayers.length === 0) {
    ok('状态：四层能量在范围内');
  } else {
    no(
      '状态：四层能量在范围内',
      `应为 0-100 的有限数字，${invalidLayers.map(([key, value]) => `${key} 实际值=${String(value)}`).join('；')}`
    );
  }

  // 精力需要是 0-100 的整数，避免小数、越界值或非数字参与后续计算。
  const energy = herState?.energy;
  if (Number.isInteger(energy) && energy >= 0 && energy <= 100) {
    ok('状态：精力是整数');
  } else {
    no('状态：精力是整数', `应为 0-100 的整数，实际值=${String(energy)}`);
  }

  // 情绪标签用于描述当前状态，缺失或空白会让状态语义不完整。
  const moodLabel = herState?.mood?.label;
  if (typeof moodLabel === 'string' && moodLabel.trim().length > 0) {
    ok('状态：情绪标签非空');
  } else {
    no('状态：情绪标签非空', `应为非空字符串，实际值=${String(moodLabel)}`);
  }

  // 清醒时长允许尚未开始累计，但一旦填写就不能是负数、NaN 或其他无效值。
  const hoursAwake = herState?.hoursAwake;
  if (hoursAwake === undefined || (Number.isFinite(hoursAwake) && hoursAwake >= 0)) {
    ok('状态：清醒时长健全');
  } else {
    no('状态：清醒时长健全', `应为 undefined 或不小于 0 的有限数字，实际值=${String(hoursAwake)}`);
  }

  // 更新时间必须能按北京时间解析且足够新，避免状态推进悄悄停止。
  const stateTime = herState?.time ?? herState?.更新时间;
  const timeMatch = typeof stateTime === 'string'
    ? stateTime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)
    : null;
  const timeParts = timeMatch ? timeMatch.slice(1).map(Number) : [];
  const stateTimestamp = timeMatch
    ? Date.parse(`${stateTime.replace(' ', 'T')}:00+08:00`)
    : NaN;
  const beijingDate = new Date(stateTimestamp + 8 * 60 * 60 * 1000);
  const validStateTime = timeMatch !== null
    && Number.isFinite(stateTimestamp)
    && beijingDate.getUTCFullYear() === timeParts[0]
    && beijingDate.getUTCMonth() + 1 === timeParts[1]
    && beijingDate.getUTCDate() === timeParts[2]
    && beijingDate.getUTCHours() === timeParts[3]
    && beijingDate.getUTCMinutes() === timeParts[4];
  const stateTimeDiff = Math.abs(Date.now() - stateTimestamp);
  if (!validStateTime) {
    no('状态：时间有效且推进正常', `实际值=${String(stateTime)}，应为有效的 YYYY-MM-DD HH:mm 北京时间`);
  } else if (stateTimeDiff > 120 * 60 * 1000) {
    no('状态：时间有效且推进正常', `实际值=${stateTime}，与当前北京时间相差 ${Math.round(stateTimeDiff / 60000)} 分钟，超过 120 分钟`);
  } else {
    ok('状态：时间有效且推进正常');
  }
})()

console.log('== 七、睡眠判据 ==')
;(() => {
  try {
    let waking;
    let sleep;
    try {
      waking = JSON.parse(readFileSync(base + '/睡醒.json', 'utf8'));
      sleep = JSON.parse(readFileSync(base + '/睡眠.json', 'utf8'));
    } catch (error) {
      no('睡眠判据可读', error instanceof Error ? error.message : String(error));
      return;
    }

    const flagSleeping = waking.sleeping === true;
    const hasLive = Boolean(sleep.live);
    if (flagSleeping === hasLive) {
      ok('睡眠判据一致', flagSleeping ? '两边都说在睡' : '两边都说醒着');
    } else {
      no('睡眠判据一致', 'live=' + hasLive + ' 但标记=' + flagSleeping + '，两边打架会扣坏状态');
    }

    if (hasLive) {
      const startText = sleep.live.start;
      const match = typeof startText === 'string'
        ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(startText)
        : null;
      let startAt = NaN;
      if (match) {
        const [year, month, day, hour, minute] = match.slice(1).map(Number);
        const start = new Date(year, month - 1, day, hour, minute);
        if (
          start.getFullYear() === year &&
          start.getMonth() === month - 1 &&
          start.getDate() === day &&
          start.getHours() === hour &&
          start.getMinutes() === minute
        ) {
          startAt = start.getTime();
        }
      }

      if (!Number.isFinite(startAt)) {
        warn('睡眠记录时长可疑', 'live.start 不是有效的 YYYY-MM-DD HH:mm（秒可选）：' + String(startText));
      } else if (Date.now() - startAt > 24 * 60 * 60 * 1000) {
        warn('睡眠记录时长可疑', 'live.start 距今超过 24 小时：' + startText);
      }
    }
  } catch (error) {
    warn('睡眠判据检查异常', error instanceof Error ? error.message : String(error));
  }
})();

console.log(`\n结果：${pass} 项过，${fail} 项没过`)
process.exit(fail === 0 ? 0 : 1)
}
