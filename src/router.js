// Per-session effort routing: trajectory -> assessment (heuristic or judge) -> hysteresis.
import { parseTurn } from './trajectory.js';
import { assess, nextState } from './policy.js';
import { judge } from './judge.js';
import { jevDecide } from './decisions.js';

const MAX_SESSIONS = 500;

export function createRouter(config, { judgeFn = judge, decideFn = jevDecide } = {}) {
  const sessions = new Map();

  function remember(key, state) {
    sessions.delete(key);
    sessions.set(key, state);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  /**
   * @param {object} body Responses or Chat Completions request body
   * @param {string} sessionKey
   * @param {{url:string, headers:Record<string,string>}|null} judgeTarget
   * @param {object} [turn] parsed trajectory; defaults to the Responses `input`
   * @returns {Promise<{effort:string, from:string|null, step:number, hold:number, reasons:string[], source:string, ms:number}>}
   */
  async function route(body, sessionKey, judgeTarget, turn = parseTurn(body.input)) {
    const started = performance.now();
    const step = turn.steps.length + 1;
    const ladder = config.ladder;
    let a = assess(turn, ladder);
    let source = 'heuristic';
    let cost = null;
    const prev = sessions.get(sessionKey);

    if (config.mode === 'jev') {
      try {
        const d = await decideFn(turn, {
          url: config.decisionUrl,
          apiKey: config.openrouterKey,
          model: config.decisionModel,
          timeoutMs: config.judgeTimeoutMs,
          ladder,
          minConfidence: config.minConfidence,
          sessionId: sessionKey,
          currentEffort: prev && step > 1 ? ladder[prev.level] : null,
        });
        cost = d.cost;
        a = d;
        source = 'jev';
      } catch (err) {
        source = `heuristic (jev failed: ${err.message})`;
      }
    } else if (config.mode === 'llm' && judgeTarget && step > 1) {
      try {
        a = await judgeFn(turn, {
          ...judgeTarget,
          model: config.judgeModel || body.model,
          effort: config.judgeEffort,
          timeoutMs: config.judgeTimeoutMs,
          ladder,
        });
        source = 'judge';
      } catch (err) {
        source = `heuristic (judge failed: ${err.message})`;
      }
    }

    const state = nextState(prev, a, step);
    remember(sessionKey, state);
    return {
      effort: ladder[state.level],
      from: state.from == null ? null : ladder[state.from],
      step,
      hold: state.hold,
      reasons: state.reasons,
      source,
      cost,
      ms: Math.round(performance.now() - started),
    };
  }

  return { route, sessions };
}
