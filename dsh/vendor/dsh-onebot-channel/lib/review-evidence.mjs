export const REVIEW_LOOKUP_NAME = 'bili_humanism_lookup_review';

export function reviewEvidenceIndex() {
  const calls = new Map();
  const turns = new Map();
  const derived = new Set();
  const pending = new Map();
  let openTurn;
  let openStep;
  return {
    turns,
    derived,
    callHasDisclosure(exec) {
      return pending.get(exec.callId)?.name === exec.name && turns.has(openTurn);
    },
    blocksMemoryWrite(exec) {
      const call = pending.get(exec.callId);
      return !call || call.name !== exec.name || exec.signal?.aborted === true || turns.has(openTurn);
    },
    observe(event) {
      const { turn, step, callId, name, message, meta } = event.data ?? {};
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        openTurn = event.type === 'turn/start' ? turn : undefined;
        openStep = undefined;
        pending.clear();
      }
      if ((event.type === 'step/start' || event.type === 'step/end') && turn === openTurn) {
        openStep = event.type === 'step/start' ? step : undefined;
        pending.clear();
      }
      if (turn === openTurn && step === openStep && Number.isSafeInteger(openStep)) {
        if (event.type === 'tool/call' && typeof callId === 'string') pending.set(callId, { name, seq: event.seq });
        if (event.type === 'tool/result' && pending.has(message?.toolCallId)
          && event.sourceEventSeqs?.includes(pending.get(message.toolCallId).seq)) pending.delete(message.toolCallId);
      }
      if (event.type === 'tool/call' && name === REVIEW_LOOKUP_NAME && Number.isSafeInteger(turn) && typeof callId === 'string') {
        calls.set(callId, { turn, step, seq: event.seq });
      }
      if (event.type === 'tool/result' && message?.isError === false && event.surfaceOp === 'append'
        && meta?.biliReviewDisclosure !== false) {
        const call = calls.get(message.toolCallId);
        if (call && call.turn === turn && call.step === step && event.sourceEventSeqs?.includes(call.seq) && !turns.has(turn)) {
          turns.set(turn, event.seq);
        }
      }
      if (event.type === 'user/message' && event.data?.source?.biliReviewExpired !== true
        && event.surfaceOp?.op === 'replace' && event.sourceEventSeqs?.some((seq) => derived.has(seq))) derived.add(event.seq);
      if (['assistant/message', 'tool/call', 'tool/result'].includes(event.type) && turns.get(turn) <= event.seq) derived.add(event.seq);
    },
  };
}

const cursors = new WeakMap();

export function reviewEvidenceOf(session) {
  if (typeof session?.snapshotEvents !== 'function') return reviewEvidenceIndex();
  let state = cursors.get(session);
  if (!state || session.seq < state.end) {
    state = { end: 0, index: reviewEvidenceIndex() };
    cursors.set(session, state);
  }
  const events = session.snapshotEvents(state.end);
  for (const event of events) state.index.observe(event);
  if (events.length) state.end = events.at(-1).seq + 1;
  return state.index;
}

export function isReviewDerivedCall(exec) {
  const session = exec?.agent?.session;
  if (typeof session?.snapshotEvents !== 'function' || typeof exec?.callId !== 'string' || exec.parent !== undefined) return true;
  return reviewEvidenceOf(session).blocksMemoryWrite(exec);
}

export function isReviewDisclosureReply(exec) {
  const session = exec?.agent?.session;
  return session && typeof exec.callId === 'string' && reviewEvidenceOf(session).callHasDisclosure(exec);
}
