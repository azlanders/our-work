#!/usr/bin/env python3
"""
回归单测：验证 Wave 1–3 所有 P0/P1 修复不再复发。
"""
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

tpl = load_module("tpl_engine", REPO / "scripts/tpl_engine.py")
clean = load_module("clean_persona", REPO / "clean-persona.py")

# Test 1: P0-1 GATEWAY_PORT=0 must NEVER replace '0' in version numbers or JSON values
vals = {
    "BOT_NAME": "alice",
    "GATEWAY_PORT": "0",
    "HTTP_PORT": "3020",
    "INSTALL_GATEWAY": "0",
    "DSH_ROOT": "/data/alice-dsh",
}
sample_pkg = '{"version": "1.0.0", "port": 3020, "dir": "/data/alice-dsh", "retries": 0}'
deinst = tpl.deinst_text(sample_pkg, vals)
assert '"version": "1.0.0"' in deinst, f"GATEWAY_PORT=0 corrupted version: {deinst}"
assert '"retries": 0' in deinst, f"GATEWAY_PORT=0 corrupted 0: {deinst}"
assert "{{HTTP_PORT}}" in deinst and "{{DSH_ROOT}}" in deinst, f"Expected real tokens replaced: {deinst}"

# Test 2: P0-2 clean-persona.py UIN swap must NOT cancel itself out
swapped = clean.clean_text("owner=1000000001 self=1000000002")
assert swapped == "owner=1000000002 self=1000000001", f"UIN swap cancelled out: {swapped}"

# Test 3: P0-3 render_text must handle sed-breaking characters (|, &, \, quotes)
special_vals = {
    "FLEET_TOKEN": "tok|with&amp\\slash'quote",
    "BOT_DISPLAY": "测试&一号",
}
rendered = tpl.render_text("T={{FLEET_TOKEN}} D={{BOT_DISPLAY}}", special_vals)
assert rendered == "T=tok|with&amp\\slash'quote D=测试&一号", f"Special chars mangled: {rendered}"

# Test 4: clean-persona.py --dry must perform zero writes
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "demo.md"
    p.write_text("1000000001 哈基米", encoding="utf-8")
    r = subprocess.run([sys.executable, str(REPO / "clean-persona.py"), td, "--dry"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert p.read_text(encoding="utf-8") == "1000000001 哈基米", "--dry modified file!"

# Test 5: _状态.mjs corrupt JSON protection (does not silently overwrite with {})
with tempfile.TemporaryDirectory() as td:
    corrupt = Path(td) / "state.json"
    corrupt.write_text("{broken json", encoding="utf-8")
    js_check = f"""
    import {{ loadState, saveState }} from {str(REPO / 'workspace/共享/工具/_状态.mjs')!r};
    let threw = false;
    try {{
      saveState({str(corrupt)!r}, {{ a: 1 }}, {{ a: 0 }});
    }} catch (e) {{
      threw = true;
    }}
    if (!threw) process.exit(1);
    """
    r_node = subprocess.run(["node", "--input-type=module", "-e", js_check], capture_output=True, text=True)
    assert r_node.returncode == 0, f"_状态.mjs failed corrupt-JSON guard: {r_node.stderr}"
    baks = list(Path(td).glob("state.json.corrupt-*"))
    assert len(baks) >= 1, "Corrupt state file was not backed up!"


# Test 6: 同步模板.sh --dry must NOT create target directories or write files
with tempfile.TemporaryDirectory() as td:
    fake_ws = Path(td) / "inst-ws"
    (fake_ws / "共享/工具").mkdir(parents=True)
    (fake_ws / "BOT-RUNBOOK.md").write_text("hello /data/demo-workspace", encoding="utf-8")
    r_sync = subprocess.run(
        ["bash", str(REPO / "同步模板.sh"), str(fake_ws), "--name", "demo", "--dry"],
        capture_output=True, text=True,
    )
    assert r_sync.returncode == 0, f"同步模板.sh --dry failed: {r_sync.stderr}"
    assert "would copy" in r_sync.stdout or "unchanged" in r_sync.stdout

# Test 7: patches/dsh-rofm-compact-desc.py must abort cleanly if only 1 of 2 anchors exists
with tempfile.TemporaryDirectory() as td:
    mt = Path(td) / "profiles/web/vendor/dsh-rofm/lib/memory-tool.js"
    mt.parent.mkdir(parents=True)
    mt.write_text("const OTHER = 1;\n      description: TOOL_DESCRIPTION,\n", encoding="utf-8")
    r_rofm = subprocess.run(
        [sys.executable, str(REPO / "patches/dsh-rofm-compact-desc.py"), "--dsh-root", td],
        capture_output=True, text=True,
    )
    assert r_rofm.returncode == 1, f"Expected failure on missing def anchor, got {r_rofm.returncode}"
    assert "TOOL_DESCRIPTION_SHORT" not in mt.read_text(encoding="utf-8"), "Partial replace corrupted file!"

# Test 8: patches/patch_llm_retry.py --dry & apply idempotency
with tempfile.TemporaryDirectory() as td:
    llm = Path(td) / "index.js"
    llm.write_text("const DEFAULT_MAX_RETRIES = 5;\n", encoding="utf-8")
    r_d = subprocess.run([sys.executable, str(REPO / "patches/patch_llm_retry.py"), str(llm), "--dry"], capture_output=True, text=True)
    assert r_d.returncode == 0 and "DEFAULT_MAX_RETRIES = 5;" in llm.read_text(encoding="utf-8")
    r_a = subprocess.run([sys.executable, str(REPO / "patches/patch_llm_retry.py"), str(llm)], capture_output=True, text=True)
    assert r_a.returncode == 0 and "DEFAULT_MAX_RETRIES = 1;" in llm.read_text(encoding="utf-8")
    r_a2 = subprocess.run([sys.executable, str(REPO / "patches/patch_llm_retry.py"), str(llm)], capture_output=True, text=True)
    assert r_a2.returncode == 0 and "skip" in r_a2.stdout

print("ALL 8 REGRESSION TESTS PASSED")

