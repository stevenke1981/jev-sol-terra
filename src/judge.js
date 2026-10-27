// Optional LLM judge: asks a small model to pick the effort for the next
// generation. Falls back to the heuristic on timeout or malformed output.

const INSTRUCTIONS = `You route reasoning effort for a coding agent. Given the user's request and the
agent's recent steps, choose the effort for its NEXT generation.
- Use the lowest rung for routine work: reading files, listing, straightforward commands, greetings.
- Go up when the agent is stuck: repeated failures, the same failing command, confusing errors,
  or when it must synthesize many findings into a diagnosis or a non-trivial edit.
Answer with JSON only: {"effort":"<one of LADDER>","hold":<0-3 generations to keep it>,"reason":"<under 12 words>"}`;

const MAX_STEPS = 10;
const MAX_CMD = 160;

export function summarize(turn) {
  const steps = turn.steps.slice(-MAX_STEPS).map((s, i) => {
    const status = s.failed == null ? 'pending' : s.failed ? 'FAILED' : 'ok';
    return `${i + 1}. [${s.kind}] ${status}: ${s.command.replace(/\s+/g, ' ').slice(0, MAX_CMD)}`;
  });
  return `User request:\n${turn.userText.slice(0, 1200)}\n\nRecent steps (${turn.steps.length} total):\n${steps.join('\n') || '(none yet)'}`;
}

export function parseVerdict(text, ladder) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    const target = ladder.indexOf(String(v.effort).toLowerCase());
    if (target < 0) return null;
    const hold = Math.max(0, Math.min(3, Number.parseInt(v.hold, 10) || 0));
    return { target, hold, reasons: [`judge: ${String(v.reason ?? '').slice(0, 80)}`] };
  } catch {
    return null;
  }
}

// Collects output text from a Responses SSE stream (or a plain JSON body).
export async function readOutputText(res) {
  const raw = await res.text();
  if (!raw.trimStart().startsWith('event:') && !raw.trimStart().startsWith('data:')) {
    try {
      const body = JSON.parse(raw);
      return (body.output ?? []).flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
    } catch {
      return '';
    }
  }
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(line.slice(5));
      if (ev.type === 'response.output_text.delta') text += ev.delta ?? '';
    } catch {
      // Non-JSON keepalive lines are expected in SSE.
    }
  }
  return text;
}

/**
 * @param {{url:string, headers:Record<string,string>, model:string, effort:string, timeoutMs:number, ladder:string[]}} opts
 */
export async function judge(turn, opts) {
  const body = {
    model: opts.model,
    instructions: INSTRUCTIONS.replace('LADDER', opts.ladder.join('|')),
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: summarize(turn) }] }],
    reasoning: { effort: opts.effort },
    stream: true,
    store: false,
  };
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: { ...opts.headers, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
  const verdict = parseVerdict(await readOutputText(res), opts.ladder);
  if (!verdict) throw new Error('judge returned no usable verdict');
  return verdict;
}
