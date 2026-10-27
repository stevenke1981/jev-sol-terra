// Chat Completions support: turns `messages` (as sent by opencode, aider, crush…)
// into the same turn shape as trajectory.parseTurn, and rewrites the effort field.
import crypto from 'node:crypto';
import { classifyCall, outputFailed, textOf, isSyntheticUserText } from './trajectory.js';

function chatText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  return content.filter((p) => p?.type === 'text' || typeof p === 'string').map(textOf).filter(Boolean).join('\n');
}

function isRealUser(m) {
  return m?.role === 'user' && !isSyntheticUserText(chatText(m.content));
}

/** @returns {{userText: string, steps: Array<{kind: string, command: string, failed: boolean|null}>, assistantMessages: number}} */
export function parseChatTurn(messages) {
  const items = Array.isArray(messages) ? messages : [];
  const start = items.findLastIndex(isRealUser);
  const userText = start >= 0 ? chatText(items[start].content) : '';
  const calls = new Map();
  const steps = [];
  let assistantMessages = 0;

  for (const m of items.slice(start + 1)) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'assistant') {
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (toolCalls.length === 0) assistantMessages++;
      for (const tc of toolCalls) {
        const call = { type: 'function_call', name: tc?.function?.name, arguments: tc?.function?.arguments };
        const step = { kind: classifyCall(call), command: commandOfChat(call), failed: null };
        steps.push(step);
        if (tc?.id) calls.set(tc.id, step);
      }
    } else if (m.role === 'tool') {
      const step = calls.get(m.tool_call_id);
      if (step) step.failed = outputFailed(chatText(m.content), step.command);
    }
  }
  return { userText, steps, assistantMessages };
}

function commandOfChat(call) {
  try {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments ?? {};
    const cmd = args.cmd ?? args.command;
    if (cmd != null) return Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
  } catch {
    // Fall through to the raw form.
  }
  const raw = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
  return `${call.name} ${raw.slice(0, 200)}`;
}

/** Whether this request already asks for reasoning (so rewriting the effort is safe). */
export function chatWantsReasoning(body) {
  return typeof body.reasoning_effort === 'string'
    || (body.reasoning != null && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning));
}

// Rewrites the effort in whichever form the client used. OpenRouter ignores
// reasoning params a model does not support, so there it is also injected.
export function applyChatEffort(body, effort, inject) {
  const out = { ...body };
  if (typeof body.reasoning_effort === 'string') out.reasoning_effort = effort;
  if (body.reasoning && typeof body.reasoning === 'object') out.reasoning = { ...body.reasoning, effort };
  if (inject && !chatWantsReasoning(body)) out.reasoning = { effort };
  return out;
}

// Chat requests carry no conversation id; the first user message identifies one.
export function chatSessionKey(body, headers) {
  const explicit = body.prompt_cache_key ?? body.user ?? headers.session_id ?? headers['x-session-id'];
  if (explicit != null) return String(explicit);
  const first = (Array.isArray(body.messages) ? body.messages : []).find((m) => m?.role === 'user');
  const seed = `${body.model ?? ''}\n${chatText(first?.content)}`;
  return `chat:${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}
