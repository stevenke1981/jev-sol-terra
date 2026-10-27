// TypeSafe Jev (typesafe/jev-1.14) via the OpenRouter Decisions API:
// typed questions in, probabilities out — no generated text to parse.

const MAX_STEPS = 12;
const MAX_CMD = 200;
const MAX_TASK = 2000;

const EFFORT_CRITERIA = {
  minimal: 'Trivial: a greeting or a purely mechanical next step.',
  low: 'Routine: reading files, listing, running a known command, an obvious follow-up after success.',
  medium: 'Needs thought: synthesizing many findings, planning or writing a non-trivial edit, interpreting a fresh failure.',
  high: 'Stuck or high stakes: repeated failures, the same failing command again, confusing errors, a subtle bug.',
  xhigh: 'Deeply stuck: many failed attempts in a row; the approach must change entirely.',
};

export function buildState(turn, currentEffort) {
  const steps = turn.steps;
  let consecutive = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].failed; i--) consecutive++;
  return {
    task: turn.userText.slice(0, MAX_TASK),
    next_generation: steps.length + 1,
    current_effort: currentEffort ?? null,
    totals: {
      tool_calls: steps.length,
      failures: steps.filter((s) => s.failed).length,
      consecutive_failures: consecutive,
      edits: steps.filter((s) => s.kind === 'edit').length,
    },
    recent_steps: steps.slice(-MAX_STEPS).map((s, i, arr) => ({
      n: steps.length - arr.length + i + 1,
      kind: s.kind,
      status: s.failed == null ? 'running' : s.failed ? 'failed' : 'ok',
      command: s.command.replace(/\s+/g, ' ').slice(0, MAX_CMD),
    })),
  };
}

export function buildQuestions(ladder) {
  return {
    effort: {
      type: 'score',
      instructions: 'How much reasoning should the coding agent spend on its NEXT generation, given the task and its recent steps?',
      criteria: ladder.map((e) => `${e}: ${EFFORT_CRITERIA[e]}`),
    },
    stuck: {
      type: 'noul',
      instructions: 'Is the coding agent stuck right now — failing repeatedly or going in circles?',
      criteria: {
        true: 'Recent steps keep failing or repeat the same unsuccessful action.',
        false: 'The agent is making progress, or its last step succeeded.',
      },
    },
    strong: {
      type: 'noul',
      instructions: 'Does the NEXT generation need the strongest, most expensive coding model?',
      criteria: {
        true: 'Hard coding or long-horizon work: deep debugging, architecture, a subtle multi-file change, a long agentic task.',
        false: 'Routine work a cheaper model handles well: reading, simple edits, commands, prose.',
      },
    },
  };
}

/** Maps Jev answers onto the policy's assessment shape. */
export function toAssessment(answers, ladder, minConfidence) {
  const effort = answers?.effort;
  const stuck = answers?.stuck?.noul;
  // Optional: an answer set without the model question still routes effort.
  const strong = answers?.strong?.noul;
  if (effort?.type !== 'score' || typeof effort.score !== 'number' || typeof stuck !== 'number') {
    throw new Error('Jev returned an unexpected answer shape');
  }
  if ((effort.confidence ?? 1) < minConfidence) {
    throw new Error(`Jev confidence ${effort.confidence.toFixed(2)} < ${minConfidence}`);
  }
  const target = Math.max(0, Math.min(ladder.length - 1, Math.round(effort.score)));
  const hold = stuck >= 0.75 ? 2 : stuck >= 0.5 ? 1 : 0;
  return {
    target,
    hold,
    release: stuck < 0.25,
    strong: typeof strong === 'number' ? strong : null,
    stuck,
    reasons: [`jev score ${effort.score.toFixed(2)} (conf ${(effort.confidence ?? 0).toFixed(2)}), stuck ${stuck.toFixed(2)}`
      + (typeof strong === 'number' ? `, strong ${strong.toFixed(2)}` : '')],
  };
}

/**
 * @param {{url:string, apiKey:string, model:string, timeoutMs:number, ladder:string[],
 *          minConfidence:number, sessionId?:string, currentEffort?:string}} opts
 * @returns {Promise<{target:number, hold:number, release:boolean, strong:number|null, reasons:string[], cost:number|null}>}
 */
export async function jevDecide(turn, opts) {
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      state: buildState(turn, opts.currentEffort),
      questions: buildQuestions(opts.ladder),
      ...(opts.sessionId ? { session_id: opts.sessionId.slice(0, 256) } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${body?.error?.message ?? 'no error body'}`);
  return { ...toAssessment(body?.answers, opts.ladder, opts.minConfidence), cost: body?.usage?.cost ?? null };
}
