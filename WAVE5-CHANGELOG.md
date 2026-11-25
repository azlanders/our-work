# azlanders/our-work Wave 5 多实例防串写与异常处理加固说明

本压缩包承接 `our-work-refactor-wave1-3.zip` 与 `our-work-refactor-wave4.zip`，消除业务工具中残留的跨实例 `/tmp` 路径碰撞、硬编码客户端路径与静默空 `catch {}`。

## 变更文件清单

1. **`workspace/共享/工具/面板.mjs` 与 `workspace/共享/工具/qq扫码.py`**
   - 将硬编码的 `/tmp/qqqr-hajimi.png`、`/tmp/_qqwin.png` 与 `QQ扫码客户端: '/data/qq-qq/app/qq'` 全部模板化为 `/tmp/qqqr-{{BOT_NAME}}.png`、`/tmp/_qqwin-{{BOT_NAME}}.png`（通过新增 `QQWIN_OUT` 环境变量联动）与 `{{QQ_HOME}}/app/qq`，杜绝多 bot 同机扫码互相覆盖。
2. **`workspace/共享/工具/接口网关.mjs`**
   - 将 `/tmp/hajimi-dump.on`、`/tmp/hajimi-req.jsonl`、`/tmp/hajimi-req-full.json` 改为 `/tmp/{{BOT_NAME}}-*`，并将 13 处静默空 `catch {}` 替换为带模块前缀的 `console.error('[接口网关]', ...)`。
3. **`workspace/共享/工具/一起听歌.mjs`**
   - 将 `/tmp/ncm-who.log` 改为 `/tmp/{{BOT_NAME}}-ncm-who.log`，并将 12 处静默空 `catch {}` 替换为带模块前缀的 `console.error('[一起听歌]', ...)`。
4. **`自检.sh`**
   - 在实例残留扫描规则中新增 `/tmp/hajimi-`、`/tmp/qqqr-hajimi` 与 `/data/qq-qq` 拦截项，防止此类跨实例串写复发。

## 应用与验证步骤

```bash
unzip -o our-work-refactor-wave5.zip -d .
chmod +x 自检.sh workspace/共享/工具/qq扫码.py
bash 自检.sh
```
