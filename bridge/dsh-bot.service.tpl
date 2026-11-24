[Unit]
Description=DeepSeek Harness web host for QQ bot ({{BOT_NAME}} {{SELF_UIN}})
After=network-online.target snowluma.service
Wants=snowluma.service

[Service]
Type=simple
EnvironmentFile=/etc/{{BOT_NAME}}bot.env
WorkingDirectory={{BOT_ROOT}}
ExecStart=/usr/local/bin/dsh web --host 127.0.0.1 --port {{WEB_PORT}}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
