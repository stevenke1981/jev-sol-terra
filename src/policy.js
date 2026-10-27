// Decides the reasoning effort for the next generation from the current turn's
// trajectory. Escalates when the agent looks stuck, decays on routine steps.

export const HARD_TASK = /\b(design|architect|architecture|refactor|race|deadlock|concurren|security|vulnerab|prove|proof|optimi[sz]e|performance|migrat|why|root cause|debug|investigate)\b|設計|架構|重構|除錯|根因|為什麼|為何|優化|效能/i;
// Questions that ask for understanding rather than an action: Sol's other strength.
export const DEEP_QUESTION = /\b(how (does|do|did|is|are|come)|explain (how|why)|in depth|deep dive|trade-?offs?|algorithm|complexity|analy[sz]e|analysis|compare|comparison)\b|深入|原理|分析|比較|權衡|取捨|演算法|複雜度|推導|證明|怎麼運作|如何運作|運作機制|為何會/i;
const GREETING =/^\s*(hi|hello|hey|yo|thanks|thank you|ok|okay|你好|嗨|謝謝|好)\W*$/i;
export const LONG_PROMPT_CHARS = 600;
const SYNTHESIS_READS = 4;
const REPEAT_WINDOW = 6;

/** Index into `ladder` the trajectory asks for, plus reasons and hold. */
export function assess(turn, ladder) {
  const top = ladder.length - 1;
  const mid = Math.min(1, top);
  const reasons = [];
  const { steps, userText } = turn;

  if (steps.length === 0) {
    if (GREETING.test(userText)) return { target: 0, hold: 0, reasons: ['greeting'] };
    if (userText.length > LONG_PROMPT_CHARS || HARD_TASK.test(userText) || DEEP_QUESTION.test(userText)) {
      return { target: mid, hold: 0, reasons: ['hard task, planning'] };
    }
    return { target: 0, hold: 0, reasons: ['first step'] };
  }

  const streak = failureStreak(steps);
  const last = steps[steps.length - 1];
  // Only a still-failing agent counts as looping; a success ends the struggle.
  const repeats = last.failed ? repeatedFailures(steps) : 0;

  if (streak >= 3 || repeats >= 2) {
    reasons.push(streak >= 3 ? `${streak} failures in a row` : 'repeating a failing call');
    return { target: top, hold: 2, reasons };
  }
  if (streak === 2) return { target: Math.min(2, top), hold: 2, reasons: ['2 failures in a row'] };
  if (streak === 1) return { target: mid, hold: 1, reasons: [`${last.kind} failed`] };

  const recentFailures = steps.slice(-REPEAT_WINDOW).filter((s) => s.failed).length;
  if (recentFailures >= 2) return { target: mid, hold: 1, release: true, reasons: ['recovered from failures'] };

  if (last.kind === 'edit') return { target: mid, hold: 0, reasons: ['just edited code'] };
  const readsSinceEdit = countSinceLast(steps, 'edit', (s) => s.kind === 'read');
  if (readsSinceEdit >= SYNTHESIS_READS) {
    return { target: mid, hold: 0, reasons: [`${readsSinceEdit} reads to synthesize`] };
  }
  return { target: 0, hold: 0, reasons: [`routine ${last.kind}`] };
}

function failureStreak(steps) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].failed; i--) n++;
  return n;
}

function repeatedFailures(steps) {
  const seen = new Map();
  let repeats = 0;
  for (const s of steps.slice(-REPEAT_WINDOW)) {
    if (!s.failed) continue;
    const key = s.command.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) repeats++;
    seen.set(key, true);
  }
  return repeats;
}

function countSinceLast(steps, kind, pred) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].kind !== kind; i--) if (pred(steps[i])) n++;
  return n;
}

/**
 * True when generation `step` starts a new user turn rather than continuing the previous one.
 * Shared by effort hysteresis and model routing so both reset at the same point.
 * @param {{step:number}|undefined} prev session state
 * @param {number} step 1-based generation index
 */
export function isNewTurn(prev, step) {
  return !prev || step <= 1 || step <= prev.step - 1;
}

/**
 * Applies hysteresis on top of the raw assessment.
 * @param {{level:number, hold:number, step:number}|undefined} prev session state
 * @param {{target:number, hold:number, reasons:string[]}} a assessment
 * @param {number} step 1-based generation index within the turn
 * @returns {{level:number, hold:number, step:number, from:number|null, reasons:string[]}}
 */
export function nextState(prev, a, step) {
  if (isNewTurn(prev, step)) return { level: a.target, hold: a.hold, step, from: null, reasons: a.reasons };

  if (a.target > prev.level) {
    return { level: a.target, hold: a.hold, step, from: prev.level, reasons: a.reasons };
  }
  if (a.target === prev.level) {
    return { level: prev.level, hold: Math.max(a.hold, prev.hold - 1, 0), step, from: prev.level, reasons: a.reasons };
  }
  if (prev.hold > 0 && !a.release) {
    return { level: prev.level, hold: prev.hold - 1, step, from: prev.level, reasons: [...a.reasons, 'holding'] };
  }
  // Step down one rung at a time so a recovered agent does not drop straight to the floor.
  return { level: Math.max(a.target, prev.level - 1), hold: 0, step, from: prev.level, reasons: a.reasons };
}
