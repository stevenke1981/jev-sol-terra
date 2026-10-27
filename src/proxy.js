// Transparent Responses / Chat Completions proxy that rewrites only the reasoning
// effort, so the prompt prefix (and therefore prompt caching) is untouched.
import http from 'node:http';
import zlib from 'node:zlib';
import { createRouter } from './router.js';
import { parseTurn } from './trajectory.js';
import { parseChatTurn, chatWantsReasoning, applyChatEffort, chatSessionKey } from './chat.js';
import { createDecisionLog, formatDecision, usageTokens } from './log.js';
import { VERSION, BUILD } from './version.js';

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'content-encoding', 'accept-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer']);
const DECODERS = {
  zstd: (b) => zlib.zstdDecompressSync(b),
  gzip: (b) => zlib.gunzipSync(b),
  br: (b) => zlib.brotliDecompressSync(b),
  deflate: (b) => zlib.inflateSync(b),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(buf, encoding) {
  if (!encoding || encoding === 'identity') return buf;
  const fn = DECODERS[encoding.toLowerCase()];
  if (!fn) throw new Error(`unsupported content-encoding: ${encoding}`);
  return fn(buf);
}

function forwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v != null) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function isChatGptAuth(headers) {
  if (headers['chatgpt-account-id']) return true;
  const auth = String(headers.authorization ?? '');
  return /^Bearer\s+eyJ/.test(auth);
}

export function upstreamBase(config, headers) {
  if (config.upstream) return config.upstream.replace(/\/$/, '');
  if (isChatGptAuth(headers)) return config.chatgptUpstream;
  if (/^Bearer\s+sk-or-/.test(String(headers.authorization ?? ''))) return config.openrouterUpstream;
  return config.apiUpstream;
}

// "/v1/responses?x" -> "<base>/responses?x"; refuses anything that would leave the base origin.
export function upstreamUrl(base, reqUrl) {
  if (!reqUrl.startsWith('/') || reqUrl.startsWith('//')) throw new BadRequest(`invalid request path: ${reqUrl}`);
  const url = base + reqUrl.replace(/^\/v1(?=\/|$)/, '');
  if (new URL(url).origin !== new URL(base).origin) throw new BadRequest(`invalid request path: ${reqUrl}`);
  return url;
}

class BadRequest extends Error {}

function sessionKeyOf(body, headers) {
  return String(body.prompt_cache_key ?? headers.session_id ?? headers.conversation_id ?? 'default');
}

const MAX_JSON_SNIFF = 4 * 1024 * 1024;

// Per-protocol hooks: how to read the trajectory, whether the request is a
// reasoning request, and how to rewrite its effort.
const PROTOCOLS = {
  responses: {
    parse: (body) => parseTurn(body.input),
    wantsReasoning: (body) => body.reasoning != null && typeof body.reasoning === 'object',
    apply: (body, effort) => ({ ...body, reasoning: { ...body.reasoning, effort } }),
    session: sessionKeyOf,
    judge: true,
  },
  chat: {
    parse: (body) => parseChatTurn(body.messages),
    wantsReasoning: chatWantsReasoning,
    apply: applyChatEffort,
    session: chatSessionKey,
    // The LLM judge speaks the Responses API, which chat-only upstreams lack.
    judge: false,
  },
};

function isOpenRouter(base) {
  return /(^|\.)openrouter\.ai$/i.test(new URL(base).hostname);
}

// Watches the response for the final usage without buffering an SSE stream:
// Responses `response.completed`, a chat chunk's `usage`, or a plain JSON body.
function usageSniffer(contentType) {
  const decoder = new TextDecoder();
  const isJson = /application\/json/i.test(contentType ?? '');
  let pending = '';
  let usage = null;
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      if (isJson) {
        if (pending.length > MAX_JSON_SNIFF) pending = '';
        return;
      }
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
        try {
          const event = JSON.parse(line.slice(5));
          usage = event.response?.usage ?? event.usage ?? usage;
        } catch {
          // Partial or non-JSON data line; ignore.
        }
      }
    },
    finish() {
      if (!isJson || !pending) return;
      try {
        const body = JSON.parse(pending);
        usage = body.usage ?? body.response?.usage ?? usage;
      } catch {
        // Truncated or non-JSON body; no usage.
      }
    },
    get usage() {
      return usage;
    },
  };
}

async function pipeUpstream(res, upstream, onChunk) {
  const headers = forwardHeaders(Object.fromEntries(upstream.headers));
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) {
    onChunk?.(chunk);
    // Respect backpressure so a slow client does not make us buffer the whole stream.
    if (!res.write(chunk) && !res.destroyed) await drainOrClose(res);
    if (res.destroyed) return;
  }
  res.end();
}

function drainOrClose(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function abortOnClose(res) {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  return controller.signal;
}

export function createProxy(config, deps = {}) {
  const router = createRouter(config, deps);
  const log = deps.log ?? createDecisionLog(config);
  const print = deps.print ?? ((s) => process.stdout.write(`${s}\n`));
  const stats = { requests: 0, routed: 0, byEffort: {}, reasoningTokens: {} };
  const identity = { version: VERSION, build: BUILD, pid: process.pid, startedAt: new Date().toISOString() };

  async function handleRouted(req, res, raw, protocol) {
    const base = upstreamBase(config, req.headers);
    const url = upstreamUrl(base, req.url);
    let body;
    try {
      body = JSON.parse(decode(raw, req.headers['content-encoding']).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected a JSON object');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `jev: bad request body: ${err.message}` } }));
    }

    let decision = null;
    const session = protocol.session(body, req.headers);
    // OpenRouter drops reasoning params a model lacks, so chat requests there are routed even without one.
    const inject = protocol === PROTOCOLS.chat && isOpenRouter(base);
    if (config.mode !== 'off' && (protocol.wantsReasoning(body) || inject)) {
      const judgeTarget = protocol.judge ? { url, headers: forwardHeaders(req.headers) } : null;
      decision = await router.route(body, session, judgeTarget, protocol.parse(body));
      body = protocol.apply(body, decision.effort, inject);
      stats.routed++;
      stats.byEffort[decision.effort] = (stats.byEffort[decision.effort] ?? 0) + 1;
      if (!config.quiet) print(formatDecision(decision));
    }

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { ...forwardHeaders(req.headers), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortOnClose(res),
    });
    const sniff = usageSniffer(upstream.headers.get('content-type'));
    await pipeUpstream(res, upstream, (c) => sniff.push(c));
    sniff.finish();

    if (decision) {
      const { reasoning } = usageTokens(sniff.usage);
      if (reasoning != null) {
        stats.reasoningTokens[decision.effort] = (stats.reasoningTokens[decision.effort] ?? 0) + reasoning;
      }
      log.write({
        ts: new Date().toISOString(), model: body.model, session, api: protocol === PROTOCOLS.chat ? 'chat' : 'responses',
        ...decision, status: upstream.status, usage: sniff.usage,
      });
    }
  }

  async function handle(req, res) {
    stats.requests++;
    if (req.url === '/jev/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...identity, mode: config.mode, ladder: config.ladder, stats }));
    }
    const raw = await readBody(req);
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && path.endsWith('/responses')) return handleRouted(req, res, raw, PROTOCOLS.responses);
    if (req.method === 'POST' && path.endsWith('/chat/completions')) return handleRouted(req, res, raw, PROTOCOLS.chat);

    const upstream = await fetch(upstreamUrl(upstreamBase(config, req.headers), req.url), {
      method: req.method,
      headers: forwardHeaders(req.headers),
      body: raw.length ? decode(raw, req.headers['content-encoding']) : undefined,
      signal: abortOnClose(res),
    });
    return pipeUpstream(res, upstream);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err.name === 'AbortError') return;
      if (err instanceof BadRequest && !res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `jev: ${err.message}` } }));
      }
      process.stderr.write(`jev: ${req.method} ${req.url} failed: ${err.message}\n`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `jev proxy: ${err.message}` } }));
      } else {
        res.destroy(err);
      }
    });
  });
  return { server, stats, router };
}
