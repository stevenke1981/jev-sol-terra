// Parses a Responses API `input` array (as sent by Codex) into the steps of the
// current turn: everything after the latest real user message.

const READ_ONLY_CMD = /^(cat|type|head|tail|less|more|ls|dir|tree|pwd|find|fd|rg|grep|ag|sed\s+-n|awk|wc|stat|file|which|where|echo|git\s+(status|log|diff|show|branch|blame|ls-files|rev-parse|grep)|Get-Content|Get-ChildItem|Select-String)\b/i;
const VERIFY_CMD = /^(?:(?:npx|uv\s+run|poetry\s+run|python3?\s+-m|py\s+-m|\.venv\/bin\/python\s+-m)\s+)?(pytest|unittest|jest|vitest|mocha|tox|node\s+--test|cargo\s+(test|check|build|clippy)|go\s+(test|build|vet)|(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|check|typecheck)|tsc|make|gradle|mvn|ruff|mypy|eslint|dotnet\s+(test|build))\b/i;
// Search tools exit 1 for "no match"; that is an answer, not a failure.
const NO_MATCH_EXIT1 = /^(rg|grep|ag|git\s+grep|diff|git\s+diff|Select-String)\b/i;
// Case-sensitive on purpose: "failed" in ordinary output is not a failure signal.
const FAILURE_TEXT = /\b(exec_command|apply_patch|tool) failed\b|rejected: blocked by policy|\bsandbox (denied|error)\b|Permission denied|Access is denied|^aborted by user|timed out after|Traceback \(most recent call last\)|\bpanicked at\b|error\[E\d+\]|npm ERR!|command not found|is not recognized as an internal|No such file or directory|AssertionError|^FAILED\b|\b[1-9]\d* failed\b|^error:|^\S*(SyntaxError|TypeError|ModuleNotFoundError)\b|^fatal:/m;
const EXIT_CODE = /(?:Exit code:|exited with code|"exit_code"\s*:)\s*(-?\d+)/i;
const STILL_RUNNING = /Process running with session ID/i;
const SYNTHETIC_USER = /^(<(environment_context|user_instructions|user_shell_command|turn_aborted|subagent_notification|skill|INSTRUCTIONS)\b|# AGENTS\.md)/;

const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

export function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if ('output' in value) return textOf(value.output);
    if ('content' in value) return textOf(value.content);
    // Images, files and other non-text parts carry no routing signal.
    return '';
  }
  return String(value);
}

// Codex injects environment context and AGENTS.md as user-role messages; those
// are not something the human typed.
export function isSyntheticUserText(text) {
  const t = text.trimStart();
  return t.length === 0 || SYNTHETIC_USER.test(t);
}

function latestUserIndex(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === 'message' && it.role === 'user' && !isSyntheticUserText(textOf(it.content))) return i;
  }
  return -1;
}

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export function commandOf(call) {
  if (call.type === 'local_shell_call') return textOf(call.action?.command);
  if (call.type === 'custom_tool_call') return `${call.name} ${textOf(call.input).slice(0, 200)}`;
  const args = parseArgs(call.arguments);
  const cmd = args.cmd ?? args.command ?? args.raw;
  if (cmd != null) return Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
  return `${call.name} ${typeof call.arguments === 'string' ? call.arguments : JSON.stringify(args)}`;
}

// Shells are usually wrapped: ["bash","-lc","rg foo"] / "powershell -Command ...";
// leading `cd dir &&` hops are dropped so the real command is classified.
export function innerCommand(cmd) {
  const m = cmd.match(/^(?:\S*(?:bash|zsh|sh|pwsh|powershell)(?:\.exe)?)\s+(?:-\w+\s+)*(.*)$/is);
  const unwrapped = (m ? m[1] : cmd).replace(/^["']|["']$/g, '').trim();
  return unwrapped.replace(/^(?:(?:cd|Set-Location|pushd)\s+\S+\s*(?:&&|;)\s*)+/i, '');
}

export function classifyCall(call) {
  if (/apply_patch|write_file|edit/i.test(call.name ?? '')) return 'edit';
  const cmd = innerCommand(commandOf(call));
  if (/^apply_patch\b/.test(cmd)) return 'edit';
  if (VERIFY_CMD.test(cmd)) return 'verify';
  if (READ_ONLY_CMD.test(cmd)) return 'read';
  if (call.name && !/shell|exec|command/i.test(call.name)) return 'tool';
  return 'exec';
}

/** @returns {boolean|null} null when the command is still running */
export function outputFailed(output, command = '') {
  if (output && typeof output === 'object' && output.success === false) return true;
  const text = textOf(output);
  const code = text.match(EXIT_CODE);
  if (code) {
    const n = Number(code[1]);
    if (n === 1 && NO_MATCH_EXIT1.test(innerCommand(command))) return false;
    return n !== 0;
  }
  if (STILL_RUNNING.test(text)) return null;
  return FAILURE_TEXT.test(text.slice(0, 20000));
}

/**
 * @returns {{
 *   userText: string,
 *   steps: Array<{kind: string, command: string, failed: boolean|null}>,
 *   assistantMessages: number
 * }}
 */
export function parseTurn(input) {
  const items = Array.isArray(input) ? input : [];
  const start = latestUserIndex(items);
  const userText = start >= 0 ? textOf(items[start].content) : '';
  const calls = new Map();
  const steps = [];
  let assistantMessages = 0;

  for (const it of items.slice(start + 1)) {
    if (!it || typeof it !== 'object') continue;
    if (TOOL_CALL_TYPES.has(it.type)) {
      const step = { kind: classifyCall(it), command: commandOf(it), failed: null };
      steps.push(step);
      if (it.call_id ?? it.id) calls.set(it.call_id ?? it.id, step);
    } else if (TOOL_OUTPUT_TYPES.has(it.type)) {
      const step = calls.get(it.call_id);
      if (step) step.failed = outputFailed(it.output, step.command);
    } else if (it.type === 'message' && it.role === 'assistant') {
      assistantMessages++;
    }
  }
  return { userText, steps, assistantMessages };
}
