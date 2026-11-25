#!/usr/bin/env python3
"""
clean-persona.py — 把模板里的人格化/实例化文案换成中性措辞。

重构要点：
1. 使用单次正则并行扫描（multi_replace），修复 1000000001 <-> 1000000002 顺序替换互相抵消的 P0 Bug。
2. 移除硬编码 /data/bot-template/workspace 默认路径（改为相对本脚本目录的 workspace）。
3. 支持 --dry（零写入），真实写盘走 pid+random 原子替换；遇到编码异常显式告警而非静默跳过。
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import shlex
import sys
from pathlib import Path

SKIP = {"node_modules", "_归档", "备份", "临时", ".git"}
EXTS = {".md", ".mjs", ".js", ".html", ".json", ".sh", ".env", ".tpl", ".txt", ".yml", ".yaml", ".css"}

TOKENS: dict[str, str] = {
    "哈基米": "{{BOT_DISPLAY}}",
    "大肥鱼": "{{ALT_BOT_DISPLAY}}",
    "otherbot": "{{ALT_BOT_DISPLAY}}",
    "鱼片": "主人",
    "老大": "主人",
    "本鲸": "我",
    "鲸鱼娘": "人设",
    "猫娘": "人设",
    "星空紫异瞳": "深色主题",
    "1000000001": "1000000002",
    "1000000002": "1000000001",
    "806972995": "2000000001",
    "983903493": "2000000002",
    "hajimi-workspace": "bot-workspace",
    "qq-workspace": "bot-workspace",
    "hajimi-dsh": "bot-dsh",
    "hajimi-home": "bot-home",
}

SENTENCES: dict[str, str] = {
    'id="swHajimi">🐱 哈基米<': 'id="swHajimi">🐱 {{BOT_NAME}}<',
    'id="swHajimi">🐱 bot<': 'id="swHajimi">🐱 {{BOT_NAME}}<',
    ", 小蓝鲸最喜欢的地方（2.5小时）": "（2.5小时）",
    "鲸鱼发卡": "小鱼发卡",
    "饰演软萌可爱的蓝鲸少女otherbot，像真人少女贴着手机发语音一样软糯自然。":
        "饰演软萌可爱的少女，像真人少女贴着手机发语音一样软糯自然。",
    "roleTag: '本尊猫娘 · 极速全栈主脑'": "roleTag: '主脑 · 极速全栈'",
    "roleTag: '高情商猫娘嘴替 · 现成可用'": "roleTag: '备用 · 现成可用'",
    "「本鲸」是嘴上跟人打趣时才用的，写给自己看用不用这个。":
        "自称只在跟人打趣时才用，写给自己看用普通第一人称。",
    "小鲸鱼永远是完美身材": "永远是完美身材",
    "很胖的鲸鱼贴纸": "很胖的团子贴纸",
    "/* 地图定位点：鲸鱼娘冰晶光环 */": "/* 地图定位点：冰晶光环 */",
    "——自称bot、管你叫主人、深色主题人设设定就在这里维护。": "——称呼、自称、性格都在这里维护。",
    "独立于{{ALT_BOT_DISPLAY}}的人设真源": "人设真源",
    "DeepSeek 鲸鱼娘主视觉（深海鲸蓝 × 冰晶磷光 × 琉璃海雾），与 body.hajimi-mode 双空间共存。 */":
        "深色主题主视觉（深蓝 × 磷光 × 海雾），与 body.hajimi-mode 双空间共存。 */",
    "独立于otherbot的人设真源——自称bot、管你叫主人、星空紫异瞳猫娘设定就在这里维护。":
        "人设真源——称呼、自称、性格都在这里维护。",
    "独立于otherbot的人设真源——自称bot、管你叫主人、深色主题人设设定就在这里维护。":
        "人设真源——称呼、自称、性格都在这里维护。",
    "const 远端本子 = process.env.QQ_BOOK_DIR || '6af86580eab4087159c44f4ab733ad924fd52ef5'":
        "const 远端本子 = process.env.QQ_BOOK_DIR || '{{BOT_BOOK_DIR}}'\nif (!远端本子) { console.log('未配置 QQ_BOOK_DIR，跳过本子同步'); process.exit(0) }",
    "6af86580eab4087159c44f4ab733ad924fd52ef5": "{{BOT_BOOK_DIR}}",
}


def multi_replace(text: str, mapping: dict[str, str]) -> str:
    keys = sorted(mapping.keys(), key=len, reverse=True)
    if not keys:
        return text
    pat = re.compile("|".join(re.escape(k) for k in keys))
    return pat.sub(lambda m: mapping[m.group(0)], text)


def clean_text(text: str) -> str:
    # 合并整句优先 + 词项并行替换，避免任何串联覆盖或互相抵消
    t = multi_replace(text, SENTENCES)
    t = multi_replace(t, TOKENS)
    t = multi_replace(t, SENTENCES)
    return t


def atomic_write(path: Path, text: str) -> None:
    tmp = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise



def cmd_export_shell(args: argparse.Namespace) -> int:
    vals = build_vars(Path(args.env), require_install_keys=args.strict_env)
    for k, v in vals.items():
        print(f"export {k}={shlex.quote(v)}")
    return 0

def main(argv: list[str] | None = None) -> int:
    default_root = Path(__file__).resolve().parent / "workspace"
    ap = argparse.ArgumentParser(description="清理模板中的人设与实例文案")
    ap.add_argument("root", nargs="?", default=str(default_root), help="待清理目录（默认: <repo>/workspace）")
    ap.add_argument("--dry", action="store_true", help="仅演练，不写入任何文件")
    args = ap.parse_args(argv)

    root = Path(args.root)
    if not root.exists():
        print(f"clean-persona: 目录不存在: {root}", file=sys.stderr)
        return 2

    changed: list[str] = []
    skipped_errors = 0
    for p in root.rglob("*"):
        if not p.is_file() or any(part in SKIP for part in p.parts):
            continue
        if p.suffix.lower() not in EXTS:
            continue
        try:
            s = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as exc:
            skipped_errors += 1
            print(f"[clean-persona 跳过异常文件] {p}: {exc}", file=sys.stderr)
            continue
        t = clean_text(s)
        if t != s:
            if not args.dry:
                atomic_write(p, t)
            changed.append(str(p.relative_to(root)))

    prefix = "[dry] " if args.dry else ""
    print(f"{prefix}clean-persona: {len(changed)} files (errors: {skipped_errors})")
    for c in changed[:20]:
        print(" ", c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
