{
  "mode": "snapshot",
  "networks": {
    "httpServers": [
      { "name": "{{BOT_NAME}}-http", "host": "127.0.0.1", "port": {{HTTP_PORT}}, "path": "/", "enableWebSocket": false, "enableSse": false, "accessToken": "{{BRIDGE_TOKEN}}", "messageFormat": "array", "reportSelfMessage": false }
    ],
    "httpClients": [],
    "wsServers": [
      { "name": "{{BOT_NAME}}-ws", "host": "127.0.0.1", "port": {{WS_PORT}}, "path": "/", "role": "Universal", "accessToken": "{{BRIDGE_TOKEN}}", "messageFormat": "array", "reportSelfMessage": false }
    ],
    "wsClients": []
  },
  "historySync": { "enabled": false },
  "notifications": { "channelIds": [] }
}
