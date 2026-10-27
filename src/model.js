// Which model serves a generation: GPT-6.1 Sol for hard code and deep questions,
// GPT-6.1 Terra for carrying out clear instructions, computer use, visuals and writing.
// Pure functions; the router keeps the per-session state.
import { MODEL_KEYS } from './config.js';
import { HARD_TASK, DEEP_QUESTION, LONG_PROMPT_CHARS } from './policy.js';
import { isSyntheticUserText, textOf } from './trajectory.js';

const STRONG_THRESHOLD = 0.6;
const STUCK_THRESHOLD = 0.9;
const MAX_PART_DEPTH = 8;
const IMAGE_PART_TYPES = new Set(['input_image', 'image_url']);
const COMPUTER_TOOL_NAME = /browser|computer|screenshot|playwright/i;
const WRITING_TASK = /\b(write|draft|rewrite|translate|email|article|docs|readme)\b|撰寫|改寫|翻譯|文章|郵件|文案|摘要/i;
// Writing that also shows code is not a Terra job; it stays neutral.
const CODE_SIGNAL = /```|\b(code|function|class|bug|error|exception|test|tests|compile|build|typescript|javascript|python|rust|golang|sql|api|endpoint|regex|script|repo|commit|refactor|implement)\b|\.(js|ts|tsx|jsx|py|rs|go|java|kt|cs|cpp|rb|php|swift|sh|ps1|json|ya?ml|toml)\b|[{}]|\w\(\)|;\s*\n|::|=>|程式|函式|錯誤|測試|編譯|腳本/i;
// A concrete action the user spelled out: Terra carries it out, Sol only if it gets stuck.
const INSTRUCTION = /^\s*(please\s+)?(add|rename|move|delete|remove|replace|update|bump|install|uninstall|run|format|lint|create|make|set|change|insert|append|commit|list|show|open|follow)\b|^\s*(請|幫我|麻煩)?\s*(新增|加上|加入|改名|重新命名|移動|刪除|移除|替換|取代|更新|升級|安裝|執行|跑|格式化|建立|設定|修改|改成|插入|列出|開啟|照著|依照|按照)|把.{1,60}?(改成|改為|換成|設為|設成|刪掉|移到)/i;
// Three or more numbered or bulleted lines: the user already did the planning.
const STEP_LINE = /^\s*(\d+[.)、]|[-*•])\s+\S/gm;
const MIN_STEPS = 3;
// Efforts a model does not offer map onto the nearest one it does.
const EFFORT_FLOOR = { sol: { none: 'low', minimal: 'low' }, terra: { minimal: 'low' } };

const profile = (affinity, reasons) => ({ affinity, reasons });
const choice = (model, reasons) => ({ model, reasons });

/** True when any nested part carries an image (Responses input_image or Chat image_url). */
function containsImage(value, depth = 0) {
  if (depth > MAX_PART_DEPTH || value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsImage(v, depth + 1));
  if (IMAGE_PART_TYPES.has(value.type)) return true;
  return Object.values(value).some((v) => containsImage(v, depth + 1));
}

// An image-only user message is a real user message; only text-less synthetic context is not.
function isRealUserItem(item) {
  if (item?.role !== 'user') return false;
  return containsImage(item.content) || !isSyntheticUserText(textOf(item.content));
}

/** Items of the current turn: from the latest real user message on. */
function currentTurnItems(body) {
  const items = Array.isArray(body?.input) ? body.input : Array.isArray(body?.messages) ? body.messages : [];
  const start = items.findLastIndex(isRealUserItem);
  return items.slice(Math.max(start, 0));
}

// A built-in computer-use tool counts as soon as it is offered. Browser or screenshot
// tools from MCP servers are often mounted in every session, so they count only once
// this turn actually calls one.
function usesComputer(tools, turn) {
  const offered = Array.isArray(tools) && tools.some((t) => typeof t?.type === 'string' && /computer/.test(t.type));
  // Only named tool calls: a shell step like `playwright test` is an E2E run, not computer use.
  return offered || (turn?.steps ?? []).some((s) => s.kind === 'tool' && COMPUTER_TOOL_NAME.test(String(s.command).split(/\s/, 1)[0]));
}

/**
 * Which model the task suits, first matching rule wins.
 * @param {object} body Responses or Chat Completions request body
 * @param {{userText:string}} turn parsed trajectory of the current turn
 * @returns {{affinity:'terra'|'sol'|'neutral', reasons:string[]}}
 */
export function taskProfile(body, turn) {
  const userText = turn?.userText ?? '';
  if (currentTurnItems(body).some((it) => containsImage(it))) return profile('terra', ['images in this turn']);
  if (usesComputer(body?.tools, turn)) return profile('terra', ['computer use']);
  if (HARD_TASK.test(userText)) return profile('sol', ['hard task']);
  if (DEEP_QUESTION.test(userText)) return profile('sol', ['deep question']);
  // Neutral starts on terra and escalates to sol only when the turn gets stuck.
  const steps = userText.match(STEP_LINE)?.length ?? 0;
  if (steps >= MIN_STEPS) return profile('neutral', [`clear instructions (${steps} steps)`]);
  if (userText.length > LONG_PROMPT_CHARS) return profile('sol', [`long prompt (${userText.length} chars)`]);
  // Before writing: "依照 README 安裝依賴" names a doc but asks for an action.
  if (INSTRUCTION.test(userText)) return profile('neutral', ['clear instructions']);
  if (WRITING_TASK.test(userText)) {
    return CODE_SIGNAL.test(userText) ? profile('neutral', ['writing with code']) : profile('terra', ['writing task']);
  }
  return profile('neutral', ['no strong signal']);
}

/**
 * True when the client's model name hands the model choice to the router:
 * an autoModels alias, a configured model id, or 'openai/' + that id.
 */
export function wantsModelRouting(body, config) {
  const requested = typeof body?.model === 'string' ? body.model.trim().toLowerCase() : '';
  if (!requested) return false;
  if (config.autoModels.some((alias) => alias.toLowerCase() === requested)) return true;
  return MODEL_KEYS.some((key) => {
    const id = config.models[key].toLowerCase();
    return requested === id || requested === `openai/${id}`;
  });
}

/** Upstream model id. OpenRouter addresses OpenAI models as 'openai/<id>'. */
export function modelId(key, config, openRouter) {
  const id = config.models[key];
  return openRouter && !id.includes('/') ? `openai/${id}` : id;
}

/** Maps an effort the model lacks onto the nearest one it has. */
export function clampEffort(key, effort) {
  return EFFORT_FLOOR[key]?.[effort] ?? effort;
}

/**
 * Which agent sent the request. Codex marks the requests of a spawned subagent with
 * x-codex-parent-thread-id and x-openai-subagent (thread_spawn, compact, review...);
 * other clients can say so with x-jev-role.
 * @returns {'main'|'worker'}
 */
export function agentRole(headers) {
  const explicit = String(headers['x-jev-role'] ?? '').trim().toLowerCase();
  if (explicit === 'main' || explicit === 'worker') return explicit;
  return headers['x-codex-parent-thread-id'] || headers['x-openai-subagent'] ? 'worker' : 'main';
}

/**
 * Model for the next generation.
 * @param {{model?:string}|undefined} prev previous session state
 * @param {{config:object, profile:object, newTurn:boolean, level:number, top:number,
 *          strong:number|null, stuck:number|null, bodyBytes:number, role?:'main'|'worker'|null}} ctx
 *   level: effort index chosen this generation; top: ladder.length - 1;
 *   strong, stuck: probabilities from Jev's questions, or null;
 *   role: set in parallel-agents mode.
 * @returns {{model:'terra'|'sol', reasons:string[]}}
 */
export function chooseModel(prev, ctx) {
  if (ctx.config.modelMode !== 'auto') return choice(ctx.config.modelMode, ['pinned']);
  if (ctx.role === 'main') return choice('sol', ['main agent on sol']);
  if (ctx.role === 'worker') return chooseForWorker(prev, ctx);
  return ctx.newTurn ? chooseForNewTurn(prev, ctx) : chooseMidTurn(prev, ctx);
}

// A subagent carries out what the main agent handed it: terra first, sol only once it is
// stuck. Computer use, images and writing keep terra for the whole turn.
function chooseForWorker(prev, ctx) {
  if (ctx.newTurn) return choice('terra', ['subagent on terra']);
  const affinity = ctx.profile.affinity === 'terra' ? 'terra' : 'neutral';
  return chooseMidTurn(prev, { ...ctx, profile: profile(affinity, ctx.profile.reasons) });
}

function chooseForNewTurn(prev, { config, profile: taskProfileOf, bodyBytes }) {
  if (taskProfileOf.affinity === 'sol') return choice('sol', [...taskProfileOf.reasons, 'new turn']);
  if (prev?.model === 'sol' && bodyBytes > config.downgradeMaxBytes) {
    // Switching re-reads the whole context uncached, so a large body stays on sol.
    return choice('sol', [`new turn: stay sol, body ${bodyBytes} B over downgrade limit`]);
  }
  const reasons = [...taskProfileOf.reasons, 'new turn'];
  return choice('terra', prev?.model === 'sol' ? [...reasons, 'downgrade within limit'] : reasons);
}

function chooseMidTurn(prev, { profile: taskProfileOf, level, top, strong, stuck }) {
  // sol stays sol for the rest of the turn so the cached prefix is kept.
  if (prev?.model === 'sol') return choice('sol', ['mid-turn: sol kept for cache']);
  // A terra-affinity task keeps terra and uses the whole effort ladder.
  if (taskProfileOf.affinity === 'terra') return choice('terra', [...taskProfileOf.reasons, 'terra affinity']);
  if (level >= top) return choice('sol', ['mid-turn: top effort rung, escalate to sol']);
  if (typeof strong === 'number' && strong >= STRONG_THRESHOLD) {
    return choice('sol', [`mid-turn: strong ${strong.toFixed(2)}, escalate to sol`]);
  }
  // Jev's effort score seldom reaches the top rung; still stuck after a generation at
  // the rung below means terra had its chance (the heuristic's 3-failure escalation).
  if (typeof stuck === 'number' && stuck >= STUCK_THRESHOLD && level >= top - 1 && (prev?.level ?? -1) >= top - 1) {
    return choice('sol', [`mid-turn: still stuck ${stuck.toFixed(2)} at ${level === top ? 'top' : 'second'} rung, escalate to sol`]);
  }
  return choice('terra', ['mid-turn: terra']);
}
