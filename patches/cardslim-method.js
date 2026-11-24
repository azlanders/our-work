  // 旧卡片里残留的整段运行快照就地压掉。只改卡，不动用户消息，不调模型。
  scrubCards(session) {
    let count = 0;
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq);
      if (event?.type !== "user/message") continue;
      const text = eventText(session, seq);
      const kind = event?.data?.source?.kind;
      if (kind !== SPINE_SOURCE_KIND && kind !== "compact-checkpoint" && !text.includes(MARK)) continue;
      const slim = scrubCardText(text);
      if (!slim || slim.length >= text.length - 200) continue;
      session.append("user/message", createUserMessage({
        content: [{ type: "text", text: slim }],
        source: { ...(event.data?.source || spineCheckpointSource(undefined)), scrubbed: true },
      }), {
        surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      });
      count += 1;
    }
    return count;
  }

  async finishTurn(agent) {
    const state = this.stateFor(agent);
    const signal = AbortSignal.timeout(30000);
    try {
      const scrubbed = this.scrubCards(agent.session);
      if (scrubbed > 0) console.error(`[spine] scrubbed ${scrubbed} cards`);
    } catch {}
