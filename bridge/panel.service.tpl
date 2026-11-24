[Unit]
Description={{BOT_NAME}} status panel (127.0.0.1:{{PANEL_PORT}})
After=network.target

[Service]
Type=simple
Environment=PORT={{PANEL_PORT}}
Environment=ALT_BOT_KEY={{ALT_BOT_KEY}}
Environment=ALT_PANEL_PORT={{ALT_PANEL_PORT}}
Environment=QQ_PANEL_MEM={{BOT_ROOT}}/记忆
Environment=FISH_GATEWAY_PORT={{GATEWAY_PORT}}
Environment=FISH_FLEET_TOKEN={{FLEET_TOKEN}}
Environment=FISH_OMNI_CONFIG={{DSH_ROOT}}/fish-omni.json
Environment=FISH_USAGE_LOG={{DSH_ROOT}}/fish-usage-log.jsonl
WorkingDirectory={{BOT_ROOT}}/共享/工具
ExecStart=/usr/local/bin/node {{BOT_ROOT}}/共享/工具/面板.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target