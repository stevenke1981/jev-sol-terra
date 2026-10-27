// Per-session effort routing: trajectory -> assessment (heuristic or judge) -> hysteresis.
import { parseTurn } from './trajectory.js';
import { assess, nextState, isNewTurn } from './policy.js';
import { judge } from './judge.js';
import { jevDecide } from './decisions.js';
import { taskProfile, chooseModel } from './model.js';

const MAX_SESSIONS = 500;

function pickModel(config, { body, turn, prev, a, state, step, bodyBytes, role }) {
  return chooseModel(prev, {
    config,
    profile: taskProfile(body, turn),
    newTurn: isNewTurn(prev, step),
    level: state.level,
    top: config.ladder.length - 1,
    strong: a.strong ?? null,
    stuck: a.stuck ?? null,
    role,
    bodyBytes,
  });
}

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
   * @param {{url:string, headers:Record<string,string>, model?:string}|null} judgeTarget model: what
   *   the judge runs on when JEV_JUDGE_MODEL is unset (the proxy resolves aliases)
   * @param {object} [turn] parsed trajectory; defaults to the Responses `input`
   * @param {{routeModel?:boolean, bodyBytes?:number, role?:'main'|'worker'|null}} [options] routeModel: the
   *   client handed the model choice to us; bodyBytes: size of the request body; role: the
   *   agent in parallel-agents mode, whose turns start at the lowest effort rung
   * @returns {Promise<{effort:string, from:string|null, step:number, hold:number, reasons:string[], source:string,
   *   cost:number|null, ms:number, model:'terra'|'sol'|null, fromModel:string|null, modelReasons:string[]}>}
   */
  async function route(body, sessionKey, judgeTarget, turn = parseTurn(body.input), { routeModel = false, bodyBytes = 0, role = null } = {}) {
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
          model: config.judgeModel || judgeTarget.model || body.model,
          effort: config.judgeEffort,
          timeoutMs: config.judgeTimeoutMs,
          ladder,
        });
        source = 'judge';
      } catch (err) {
        source = `heuristic (judge failed: ${err.message})`;
      }
    }

    if (role && isNewTurn(prev, step)) {
      // Parallel agents start low and earn more effort by getting stuck.
      a = { ...a, target: 0, hold: 0, reasons: [...a.reasons, `${role} starts low`] };
    }
    const state = nextState(prev, a, step);
    const model = routeModel ? pickModel(config, { body, turn, prev, a, state, step, bodyBytes, role }) : null;
    const fromModel = model && !isNewTurn(prev, step) && prev?.model && prev.model !== model.model ? prev.model : null;
    // Effort-only requests keep the session's last routed model for the next routed one.
    remember(sessionKey, { ...state, model: model?.model ?? prev?.model ?? null });
    return {
      effort: ladder[state.level],
      from: state.from == null ? null : ladder[state.from],
      step,
      hold: state.hold,
      reasons: state.reasons,
      source,
      cost,
      ms: Math.round(performance.now() - started),
      model: model?.model ?? null,
      fromModel,
      modelReasons: model?.reasons ?? [],
    };
  }

  return { route, sessions };
}
