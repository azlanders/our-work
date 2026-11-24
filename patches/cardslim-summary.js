    // SUMMARIZE_CAP 2026-11-24：摘要请求原来把整段工具原文原样再发一遍（实测一次
    // 2.1MB → 150 万 token）。卡片已经带了关键摘录，这里只给模型头尾各 4000 字，
    // 整包再封顶 4 万字，够它写摘要就行。
    const SUMMARY_MSG_CHARS = 8000;
    const SUMMARY_TOTAL_CHARS = 40000;
    const messages = [];
    let summaryBudget = SUMMARY_TOTAL_CHARS;
    for (const seq of shadowedSeqs) {
      const event = session.eventAt(seq);
      const role = eventRole(session, seq);
      const raw = eventContent(session, seq);
      let content = raw;
      const text = messageText({ content: raw });
      if (text && text.length > SUMMARY_MSG_CHARS) {
        const half = SUMMARY_MSG_CHARS / 2;
        content = [{
          type: "text",
          text: `${text.slice(0, half)}\n…（中间 ${text.length - SUMMARY_MSG_CHARS} 字省略）…\n${text.slice(-half)}`,
        }];
      }
      const size = text ? text.length : 0;
      if (summaryBudget - size < 0) {
        content = [{ type: "text", text: "（这段过长，摘要在卡片里）" }];
      } else {
        summaryBudget -= size;
      }
      messages.push({
        role,
        content,
        toolCallId: event?.data?.message?.toolCallId || "",
      });
    }
