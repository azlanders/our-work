      ctx.on("session/event", (session, event) => {
        if (event?.type === "turn/start") {
          try {
            const scrubbed = this.scrubCards(session);
            if (scrubbed > 0) console.error(`[spine] scrubbed ${scrubbed} cards at turn start`);
          } catch {}
          return;
        }
        if (event?.type !== "tool/result") return;
        this.captureOne(session, event);
      });
