#!/usr/bin/env python3
# 把模板里的人格化/实例化文案换成中性措辞。同步模板.sh 拷完文件后自动跑一遍。
# 只改文案和默认值，不动功能字段。
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '/data/bot-template/workspace')
SKIP = {'node_modules', '_归档', '备份', '临时', '.git'}
EXTS = {'.md', '.mjs', '.js', '.html', '.json', '.sh', '.env', '.tpl', '.txt', '.yml', '.yaml', '.css'}

TOKENS = [
    ('哈基米', '{{BOT_DISPLAY}}'),
    ('大肥鱼', '{{ALT_BOT_DISPLAY}}'),
    ('otherbot', '{{ALT_BOT_DISPLAY}}'),
    ('鱼片', '主人'),
    ('老大', '主人'),
    ('本鲸', '我'),
    ('鲸鱼娘', '人设'),
    ('猫娘', '人设'),
    ('星空紫异瞳', '深色主题'),
    ('1000000001', '1000000002'),
    ('1000000002', '1000000001'),
    ('1000000003', '1000000003'),
    ('806972995', '2000000001'),
    ('983903493', '2000000002'),
    ('hajimi-workspace', 'bot-workspace'),
    ('qq-workspace', 'bot-workspace'),
    ('hajimi-dsh', 'bot-dsh'),
    ('hajimi-home', 'bot-home'),
]

SENTENCES = [
    ('id="swHajimi">🐱 哈基米<', 'id="swHajimi">🐱 {{BOT_NAME}}<'),
    ('id="swHajimi">🐱 bot<', 'id="swHajimi">🐱 {{BOT_NAME}}<'),
    ('，小蓝鲸最喜欢的地方（2.5小时）', '（2.5小时）'),
    ('鲸鱼发卡', '小鱼发卡'),
    ('饰演软萌可爱的蓝鲸少女otherbot，像真人少女贴着手机发语音一样软糯自然。',
     '饰演软萌可爱的少女，像真人少女贴着手机发语音一样软糯自然。'),
    ("roleTag: '本尊猫娘 · 极速全栈主脑'", "roleTag: '主脑 · 极速全栈'"),
    ("roleTag: '高情商猫娘嘴替 · 现成可用'", "roleTag: '备用 · 现成可用'"),
    ('「本鲸」是嘴上跟人打趣时才用的，写给自己看不用这个。',
     '自称只在跟人打趣时才用，写给自己看用普通第一人称。'),
    ('小鲸鱼永远是完美身材', '永远是完美身材'),
    ('很胖的鲸鱼贴纸', '很胖的团子贴纸'),
    ('/* 地图定位点：鲸鱼娘冰晶光环 */', '/* 地图定位点：冰晶光环 */'),
    ('——自称bot、管你叫主人、深色主题人设设定就在这里维护。', '——称呼、自称、性格都在这里维护。'),
    ('独立于{{ALT_BOT_DISPLAY}}的人设真源', '人设真源'),
    ('DeepSeek 鲸鱼娘主视觉（深海鲸蓝 × 冰晶磷光 × 琉璃海雾），与 body.hajimi-mode 双空间共存。 */',
     '深色主题主视觉（深蓝 × 磷光 × 海雾），与 body.hajimi-mode 双空间共存。 */'),
    ('独立于otherbot的人设真源——自称bot、管你叫主人、星空紫异瞳猫娘设定就在这里维护。',
     '人设真源——称呼、自称、性格都在这里维护。'),
    ('独立于otherbot的人设真源——自称bot、管你叫主人、深色主题人设设定就在这里维护。',
     '人设真源——称呼、自称、性格都在这里维护。'),
    ("const 远端本子 = process.env.QQ_BOOK_DIR || '6af86580eab4087159c44f4ab733ad924fd52ef5'",
     "const 远端本子 = process.env.QQ_BOOK_DIR || '{{BOT_BOOK_DIR}}'\nif (!远端本子) { console.log('未配置 QQ_BOOK_DIR，跳过本子同步'); process.exit(0) }"),
    ('6af86580eab4087159c44f4ab733ad924fd52ef5', '{{BOT_BOOK_DIR}}'),
]

changed = []
for p in root.rglob('*'):
    if not p.is_file() or any(part in SKIP for part in p.parts):
        continue
    if p.suffix.lower() not in EXTS:
        continue
    try:
        s = p.read_text(encoding='utf-8')
    except Exception:
        continue
    t = s
    for a, b in SENTENCES:
        t = t.replace(a, b)
    for a, b in TOKENS:
        t = t.replace(a, b)
    for a, b in SENTENCES:
        t = t.replace(a, b)
    if t != s:
        p.write_text(t, encoding='utf-8')
        changed.append(str(p.relative_to(root)))

print('clean-persona:', len(changed), 'files')
for c in changed[:20]:
    print('  ', c)
