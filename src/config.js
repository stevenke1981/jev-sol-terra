import os from 'node:os';
import path from 'node:path';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_KEYS = ['terra', 'sol'];
const MODEL_MODES = ['auto', ...MODEL_KEYS];

function parseLadder(raw) {
  const ladder = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = ladder.filter((e) => !EFFORTS.includes(e));
  if (bad.length || ladder.length === 0) {
    throw new Error(`JEV_LEVELS must be a comma list of ${EFFORTS.join('/')}; got "${raw}"`);
  }
  return ladder;
}

function intEnv(env, name, fallback) {
  const v = env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer; got "${v}"`);
  return n;
}

export function loadConfig(env = process.env) {
  const home = env.JEV_HOME || path.join(os.homedir(), '.jev-sol-terra');
  const openrouterKey = env.OPENROUTER_API_KEY || '';
  // With an OpenRouter key the TypeSafe Jev decision model routes by default.
  const mode = (env.JEV_MODE || (openrouterKey ? 'jev' : 'heuristic')).toLowerCase();
  if (!['jev', 'heuristic', 'llm', 'off'].includes(mode)) throw new Error(`JEV_MODE must be jev|heuristic|llm|off; got "${mode}"`);
  if (mode === 'jev' && !openrouterKey) throw new Error('JEV_MODE=jev needs OPENROUTER_API_KEY');
  const minConfidence = Number(env.JEV_MIN_CONFIDENCE ?? 0.3);
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new Error(`JEV_MIN_CONFIDENCE must be 0..1; got "${env.JEV_MIN_CONFIDENCE}"`);
  const modelMode = (env.JEV_MODEL || 'auto').toLowerCase();
  if (!MODEL_MODES.includes(modelMode)) throw new Error(`JEV_MODEL must be ${MODEL_MODES.join('|')}; got "${modelMode}"`);
  const agents = (env.JEV_AGENTS || 'parallel').toLowerCase();
  if (!['parallel', 'single'].includes(agents)) throw new Error(`JEV_AGENTS must be parallel|single; got "${agents}"`);
  return Object.freeze({
    host: env.JEV_HOST || '127.0.0.1',
    // parallel: the main agent runs on sol and spawned subagents on terra, both from low;
    // single: every request is routed by its task alone.
    agents,
    port: intEnv(env, 'JEV_PORT', 8788),
    ladder: parseLadder(env.JEV_LEVELS || 'low,medium,high,xhigh'),
    // auto: route per task between the two models; terra|sol: pin one model, route effort only.
    modelMode,
    models: Object.freeze({ terra: env.JEV_TERRA_MODEL || 'gpt-6.1-terra', sol: env.JEV_SOL_MODEL || 'gpt-6.1-sol' }),
    // Client model names that hand the model choice to the router (besides the two ids above).
    autoModels: (env.JEV_AUTO_MODELS || 'jev-auto,auto').split(',').map((s) => s.trim()).filter(Boolean),
    // Switching models re-reads the whole context uncached, so a turn may drop back
    // from sol to terra only while the request body is below this size.
    downgradeMaxBytes: intEnv(env, 'JEV_DOWNGRADE_MAX_KB', 64) * 1024,
    mode,
    // Fixed upstream; when unset the auth type picks ChatGPT backend, OpenRouter or API.
    upstream: env.JEV_UPSTREAM || '',
    chatgptUpstream: env.JEV_CHATGPT_UPSTREAM || 'https://chatgpt.com/backend-api/codex',
    apiUpstream: env.JEV_API_UPSTREAM || 'https://api.openai.com/v1',
    openrouterUpstream: env.JEV_OPENROUTER_UPSTREAM || 'https://openrouter.ai/api/v1',
    judgeModel: env.JEV_JUDGE_MODEL || '',
    judgeEffort: env.JEV_JUDGE_EFFORT || 'low',
    judgeTimeoutMs: intEnv(env, 'JEV_JUDGE_TIMEOUT_MS', 2500),
    openrouterKey,
    decisionModel: env.JEV_DECISION_MODEL || 'typesafe/jev-1.14',
    decisionUrl: env.JEV_DECISION_URL || 'https://openrouter.ai/api/alpha/decisions',
    minConfidence,
    home,
    logFile: path.join(home, 'decisions.jsonl'),
    quiet: env.JEV_QUIET === '1',
  });
}
