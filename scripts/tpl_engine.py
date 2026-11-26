#!/usr/bin/env python3
"""
scripts/tpl_engine.py — 单一事实源模板引擎（零第三方依赖）

解决的问题：
1. 淘汰根目录 6 个脚本各自复制粘贴且字段漂移的 Python/sed 替换块。
2. 修复 GATEWAY_PORT=0 等短值/哨兵值反向替换时把代码里所有 "0" 替换成 {{GATEWAY_PORT}} 的 P0 缺陷。
3. 使用单次正则并行替换，彻底消除 sed 分隔符/反向引用（| & \）崩溃与顺序替换互相覆盖。
4. 全部写盘统一走 pid + random 临时文件 + os.replace 原子写入，--dry 保证零写入。
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import shlex
import sys
from pathlib import Path

TEXT_EXTS = {
    ".md", ".mjs", ".js", ".html", ".json", ".sh", ".py",
    ".tpl", ".txt", ".yml", ".yaml", ".css", ".env",
}
SKIP_DIRS = {"node_modules", "_归档", "备份", "临时", ".git", "__pycache__"}

REQUIRED_INSTALL_KEYS = (
    "BOT_NAME", "BOT_ROOT", "DSH_ROOT", "SELF_UIN", "OWNER_UIN",
    "HTTP_PORT", "WS_PORT", "WEB_PORT", "PANEL_PORT", "BRIDGE_TOKEN", "WS_TOKEN",
)

ALL_TEMPLATE_KEYS = (
    "BOT_NAME", "BOT_DISPLAY", "BOT_NAME_UPPER", "BOT_ROOT", "DSH_ROOT",
    "QQ_HOME", "GATEWAY_URL", "BOT_BOOK_DIR",
    "ALT_BOT_DISPLAY", "ALT_BOT_KEY", "ALT_PANEL_PORT", "ALT_SELF_UIN", "GROUP_UIN",
    "SELF_UIN", "OWNER_UIN",
    "HTTP_PORT", "WS_PORT", "WEB_PORT", "PANEL_PORT", "GATEWAY_PORT",
    "INSTALL_GATEWAY", "FLEET_TOKEN", "BRIDGE_TOKEN", "WS_TOKEN",
    "SVC_BOT", "SVC_PANEL", "SVC_GATEWAY", "SVC_UPSTREAM", "SVC_WATCHDOG", "SVC_GPT",
    "PATCH_SCRIPT", "PATCH_DIR",
)

PORT_KEYS = {
    "HTTP_PORT", "WS_PORT", "WEB_PORT", "PANEL_PORT",
    "GATEWAY_PORT", "ALT_PANEL_PORT",
}

RUNTIME_PLACEHOLDERS = {
    "DATE", "MATERIAL", "AV", "PIC", "BAR", "COVER_FIRST", "READING_ID",
}

PLACEHOLDER_RE = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")


def parse_env_file(env_path: Path) -> dict[str, str]:
    """Safely parse a simple KEY=VALUE .env file without shell execution."""
    data: dict[str, str] = {}
    for lineno, raw in enumerate(env_path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"{env_path}:{lineno}: invalid env line (missing '='): {raw!r}")
        key, val = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        data[key] = val.strip()
    return data


def build_vars(env_path: Path | None = None, overrides: dict[str, str] | None = None,
               require_install_keys: bool = False) -> dict[str, str]:
    """Load variables from env file (and/or os.environ) with consistent defaults."""
    raw: dict[str, str] = {}
    if env_path is not None:
        raw.update(parse_env_file(env_path))
    else:
        for k in ALL_TEMPLATE_KEYS:
            if k in os.environ:
                raw[k] = os.environ[k]
    if overrides:
        raw.update({k: v for k, v in overrides.items() if v is not None})

    if require_install_keys:
        missing = [k for k in REQUIRED_INSTALL_KEYS if not raw.get(k)]
        if missing:
            raise ValueError("缺少必填变量: " + ", ".join(missing))

    name = raw.get("BOT_NAME", "")
    upper = re.sub(r"[^A-Z0-9]", "_", name.upper()) if name else ""

    vals: dict[str, str] = {k: raw.get(k, "") for k in ALL_TEMPLATE_KEYS}
    vals["BOT_NAME"] = name
    vals["BOT_NAME_UPPER"] = raw.get("BOT_NAME_UPPER") or upper
    vals["BOT_DISPLAY"] = raw.get("BOT_DISPLAY") or name
    vals["QQ_HOME"] = raw.get("QQ_HOME") or (f"/data/{name}-qq" if name else "")
    vals["GATEWAY_PORT"] = raw.get("GATEWAY_PORT") or "0"
    vals["INSTALL_GATEWAY"] = raw.get("INSTALL_GATEWAY") or "0"
    vals["ALT_BOT_DISPLAY"] = raw.get("ALT_BOT_DISPLAY") or "二号机"
    vals["SVC_BOT"] = raw.get("SVC_BOT") or (f"{name}-bot" if name else "")
    vals["SVC_PANEL"] = raw.get("SVC_PANEL") or (f"{name}-panel" if name else "")
    vals["SVC_GATEWAY"] = raw.get("SVC_GATEWAY") or (f"{name}-gateway" if name else "")
    vals["SVC_UPSTREAM"] = raw.get("SVC_UPSTREAM") or (f"{name}-upstream" if name else "")
    vals["SVC_WATCHDOG"] = raw.get("SVC_WATCHDOG") or (f"{name}-watchdog" if name else "")
    vals["SVC_GPT"] = raw.get("SVC_GPT") or (f"{name}-gptsovits" if name else "")
    vals["PATCH_SCRIPT"] = raw.get("PATCH_SCRIPT") or (f"reapply-patches-{name}.sh" if name else "")
    vals["PATCH_DIR"] = raw.get("PATCH_DIR") or (f"{name}-patches" if name else "")
    return vals


def multi_replace(text: str, mapping: dict[str, str]) -> str:
    """Single-pass longest-key-first replacement (immune to chaining/cancellation)."""
    filtered = {k: v for k, v in mapping.items() if k}
    if not filtered:
        return text
    keys = sorted(filtered.keys(), key=len, reverse=True)
    pat = re.compile("|".join(re.escape(k) for k in keys))
    return pat.sub(lambda m: filtered[m.group(0)], text)


def render_text(text: str, vals: dict[str, str], skip_empty: bool = False) -> str:
    """Replace template placeholders in a single pass."""
    mapping = {}
    for k, v in vals.items():
        if skip_empty and not v:
            continue
        mapping[f"{{{{{k}}}}}"] = v
    return multi_replace(text, mapping)


def is_safe_reverse_pair(key: str, val: str) -> bool:
    """Guard against catastrophic reverse replacements such as GATEWAY_PORT=0 -> {{GATEWAY_PORT}}."""
    if not val:
        return False
    if key == "INSTALL_GATEWAY":
        return False
    if key in PORT_KEYS:
        return val.isdigit() and int(val) >= 1024
    # Avoid replacing tiny generic tokens (e.g. '0', '1', 'ab') globally across code
    if key not in ("BOT_NAME", "BOT_DISPLAY", "ALT_BOT_DISPLAY", "ALT_BOT_KEY") and len(val) < 4:
        return False
    if len(val) < 2:
        return False
    return True


# vendor 里的共享包名在所有 bot 上都叫这个名字，不能跟着实例身份一起被反向替换。
FIXED_VENDOR_LITERALS = ("dsh-fish-tone", "fishtalk")


def deinst_text(text: str, vals: dict[str, str], extra_subs: dict[str, str] | None = None) -> str:
    """Safely convert instance-specific values back into template tokens."""
    mapping: dict[str, str] = {}
    for k, v in vals.items():
        if is_safe_reverse_pair(k, v):
            # Prefer more specific keys if two keys share the exact same value
            mapping.setdefault(v, f"{{{{{k}}}}}")
    if extra_subs:
        mapping.update(extra_subs)
    sentinels = {}
    masked = text
    for i, lit in enumerate(FIXED_VENDOR_LITERALS):
        token = f"\x00FIXED{i}\x00"
        if lit in masked:
            sentinels[token] = lit
            masked = masked.replace(lit, token)
    out = multi_replace(masked, mapping)
    for token, lit in sentinels.items():
        out = out.replace(token, lit)
    return out


def atomic_write_text(path: Path, text: str) -> None:
    """Atomic UTF-8 write using pid + random temp file and os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def find_unresolved_placeholders(text: str, allow_runtime: bool = True) -> list[str]:
    found = sorted(set(PLACEHOLDER_RE.findall(text)))
    if allow_runtime:
        found = [k for k in found if k not in RUNTIME_PLACEHOLDERS]
    return found


def is_binary_file(path: Path) -> bool:
    with path.open("rb") as fh:
        return b"\x00" in fh.read(4096)


def cmd_render_file(args: argparse.Namespace) -> int:
    vals = build_vars(Path(args.env) if args.env else None, require_install_keys=args.strict_env)
    src = Path(args.src)
    dst = Path(args.dst) if args.dst else None
    text = src.read_text(encoding="utf-8")
    out = render_text(text, vals, skip_empty=args.skip_empty)
    left = find_unresolved_placeholders(out)
    if args.check and left:
        print(f"FAIL 未替换占位符 ({src}): {', '.join(left)}", file=sys.stderr)
        return 3
    if dst is None:
        sys.stdout.write(out)
        return 0
    old = dst.read_text(encoding="utf-8") if dst.exists() else None
    if old == out:
        print(f"unchanged: {dst}")
        return 0
    if args.dry:
        print(f"[dry] would write: {dst}")
        return 0
    atomic_write_text(dst, out)
    if args.chmod:
        os.chmod(dst, int(args.chmod, 8))
    print(f"wrote: {dst}")
    return 0


def cmd_render_dir(args: argparse.Namespace) -> int:
    vals = build_vars(Path(args.env) if args.env else None, require_install_keys=args.strict_env)
    root = Path(args.root)
    changed = 0
    dirty: list[str] = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            p = Path(dp) / fn
            if not args.all_text and p.suffix.lower() not in TEXT_EXTS:
                continue
            if is_binary_file(p):
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            if "{{" not in text:
                continue
            out = render_text(text, vals, skip_empty=args.skip_empty)
            if out != text:
                if args.dry:
                    print(f"[dry] would render: {p.relative_to(root)}")
                else:
                    atomic_write_text(p, out)
                changed += 1
            if args.check:
                left = find_unresolved_placeholders(out)
                if left:
                    dirty.append(f"{p.relative_to(root)}: {','.join(left)}")
    print(f"rendered {changed} files in {root}")
    if dirty:
        print("FAIL 目录中仍有未渲染占位符:", file=sys.stderr)
        for item in dirty[:20]:
            print(f"  {item}", file=sys.stderr)
        return 3
    return 0


def cmd_deinst_file(args: argparse.Namespace) -> int:
    vals = build_vars(Path(args.env) if args.env else None)
    src = Path(args.src)
    dst = Path(args.dst)
    text = src.read_text(encoding="utf-8")
    out = deinst_text(text, vals)
    old = dst.read_text(encoding="utf-8") if dst.exists() else None
    if old == out:
        print(f"unchanged: {dst}")
        return 0
    if args.dry:
        print(f"[dry] would update: {dst}")
        return 0
    atomic_write_text(dst, out)
    print(f"updated: {dst}")
    return 0


def cmd_check_known(args: argparse.Namespace) -> int:
    root = Path(args.root)
    known = set(ALL_TEMPLATE_KEYS) | RUNTIME_PLACEHOLDERS
    bad: list[str] = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in {"instances", ".git", "vendor", "node_modules"}]
        for fn in fns:
            p = Path(dp) / fn
            if p.suffix.lower() not in TEXT_EXTS:
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for name in sorted(set(PLACEHOLDER_RE.findall(text))):
                if name not in known:
                    bad.append(f"{p.relative_to(root)}: {name}")
    if bad:
        print("FAIL 未定义的占位符:", file=sys.stderr)
        for item in bad:
            print(f"  {item}", file=sys.stderr)
        return 1
    print("ok 占位符都在已知列表里")
    return 0



def cmd_export_shell(args: argparse.Namespace) -> int:
    vals = build_vars(Path(args.env), require_install_keys=args.strict_env)
    for k, v in vals.items():
        print(f"export {k}={shlex.quote(v)}")
    return 0

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="bot-template 统一模板渲染与校验引擎")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("render-file")
    p1.add_argument("--env", help=".env 文件路径（缺省则读当前环境变量）")
    p1.add_argument("--src", required=True)
    p1.add_argument("--dst", help="输出路径（缺省则输出到 stdout）")
    p1.add_argument("--dry", action="store_true")
    p1.add_argument("--check", action="store_true")
    p1.add_argument("--strict-env", action="store_true")
    p1.add_argument("--skip-empty", action="store_true")
    p1.add_argument("--chmod", help="八进制权限，如 600 或 755")
    p1.set_defaults(func=cmd_render_file)

    p2 = sub.add_parser("render-dir")
    p2.add_argument("--env", help=".env 文件路径")
    p2.add_argument("--root", required=True)
    p2.add_argument("--dry", action="store_true")
    p2.add_argument("--check", action="store_true")
    p2.add_argument("--strict-env", action="store_true")
    p2.add_argument("--skip-empty", action="store_true")
    p2.add_argument("--all-text", action="store_true", help="扫描所有非二进制 UTF-8 文件（用于 vendor）")
    p2.set_defaults(func=cmd_render_dir)

    p3 = sub.add_parser("deinst-file")
    p3.add_argument("--env", help=".env 文件路径")
    p3.add_argument("--src", required=True)
    p3.add_argument("--dst", required=True)
    p3.add_argument("--dry", action="store_true")
    p3.set_defaults(func=cmd_deinst_file)

    p4 = sub.add_parser("check-known")
    p4.add_argument("--root", required=True)
    p4.set_defaults(func=cmd_check_known)

    p5 = sub.add_parser("export-shell")
    p5.add_argument("--env", required=True)
    p5.add_argument("--strict-env", action="store_true")
    p5.set_defaults(func=cmd_export_shell)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
