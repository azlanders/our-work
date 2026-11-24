[Unit]
Description={{BOT_NAME}} multi-model gateway (127.0.0.1:{{GATEWAY_PORT}})
After=network-online.target

[Service]
Type=simple
Environment=HAJIMI_UPSTREAM_PORT={{GATEWAY_PORT}}
Environment=HAJIMI_FLEET_CONFIG={{DSH_ROOT}}/{{BOT_NAME}}-fleet.json
Environment=HAJIMI_KEYS_FILE={{DSH_ROOT}}/fish-api-keys.json
Environment=HAJIMI_USAGE_LOG={{DSH_ROOT}}/fish-usage-log.jsonl
Environment=HAJIMI_RELAY_LOG={{BOT_ROOT}}/记忆/日志/接口中转.log
Environment=HAJIMI_FLEET_TOKEN={{FLEET_TOKEN}}
WorkingDirectory={{BOT_ROOT}}/共享/工具
ExecStart=/usr/local/bin/node {{BOT_ROOT}}/共享/工具/接口网关.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target