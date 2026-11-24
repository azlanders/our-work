{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-bili-humanism": "file:./vendor/dsh-bili-humanism",
    "dsh-{{ALT_BOT_KEY}}-tone": "file:./vendor/dsh-{{ALT_BOT_KEY}}-tone",
    "dsh-hippocampus": "https://codeload.github.com/coner13/dsh-hippocampus/tar.gz/refs/tags/v0.2.40-r8",
    "dsh-live-compact": "file:./vendor/dsh-live-compact",
    "dsh-memewiki": "file:./vendor/dsh-memewiki",
    "dsh-onebot-channel": "file:./vendor/dsh-onebot-channel",
    "dsh-read-animation": "0.1.2",
    "dsh-tieba-dive": "1.34.0",
    "dsh-video-storyboard": "file:./vendor/dsh-video-storyboard",
    "{{ALT_BOT_KEY}}talk": "file:./vendor/{{ALT_BOT_KEY}}talk",
    "dsh-image-cap": "file:./vendor/dsh-image-cap",
    "dsh-mnemonic": "file:./vendor/dsh-mnemonic",
    "dsh-context-trim": "file:./vendor/dsh-context-trim"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-onebot-channel",
        "dsh-hippocampus",
        "dsh-tieba-dive",
        "dsh-bili-humanism",
        "dsh-{{ALT_BOT_KEY}}-tone",
        "dsh-memewiki",
        "dsh-read-animation",
        "dsh-video-storyboard",
        "dsh-live-compact",
        "dsh-image-cap",
        "dsh-mnemonic",
        "dsh-context-trim"
      ]
    }
  }
}
