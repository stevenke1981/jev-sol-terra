# Brief: jev-sol-terra — pick GPT-6.1 Terra or Sol and the effort per generation

Repo: `D:\jev-sol-terra` (Node >= 22.15, ESM, no dependencies, tests: `node --test`).
It is a copy of the Jev effort router (`D:\jev`, branch `openrouter-jev`), read-only reference.
Read `src/*.js` and the existing tests before writing code. Match their style: small
functions, short comments that say *why*, no new dependencies, immutable updates
(return new objects, do not mutate the request body in place).

## Goal

The proxy already picks the reasoning effort for each generation (trajectory ->
heuristic / TypeSafe Jev / LLM judge -> hysteresis). Add a second decision: which of
two models serves the generation.

| key | default id | API price /1M (in / cached / out) | efforts | strengths |
|---|---|---|---|---|
| `terra` | `gpt-6.1-terra` | $1 / $0.05 / $5 | none, low..max | fast, cheap; visual reasoning, computer use, writing |
| `sol` | `gpt-6.1-sol` | $2 / $0.10 / $10 | low..max (no none/minimal) | hard coding, long-horizon agents |

On OpenRouter the ids are `openai/gpt-6.1-terra` and `openai/gpt-6.1-sol`.
Default effort ladder is now `low,medium,high,xhigh` (already in `src/config.js`).

## Shared contract (already committed: `src/config.js`)

`config.modelMode` (`auto|terra|sol`), `config.models` (`{terra, sol}` ids),
`config.autoModels` (`['jev-auto','auto']`), `config.downgradeMaxBytes` (65536),
`config.port` 8788, `config.home` `~/.jev-sol-terra`. `MODEL_KEYS` exported.

### `src/model.js` (owner A)

```js
/** Which model the task suits. */
export function taskProfile(body, turn) // -> { affinity: 'terra'|'sol'|'neutral', reasons: string[] }
/** True when the client's model name hands the model choice to the router. */
export function wantsModelRouting(body, config) // body.model is an autoModels alias, a configured id, or 'openai/' + id
/** Upstream model id; OpenRouter needs the 'openai/' prefix when the id has no '/'. */
export function modelId(key, config, openRouter) // -> string
/** Maps an effort the model lacks onto the nearest one it has (sol: none/minimal -> low; terra: minimal -> low). */
export function clampEffort(key, effort) // -> string
/** Model for the next generation. */
export function chooseModel(prev, ctx) // -> { model: 'terra'|'sol', reasons: string[] }
// ctx = { config, profile, newTurn, level, top, strong, bodyBytes }
//   prev: previous session state or undefined (has .model)
//   level: effort index chosen this generation; top: ladder.length - 1
//   strong: probability 0..1 from Jev's "strong" question, or null
```

`taskProfile` rules, first match wins:
1. Images in the current turn (Responses `input_image` parts; Chat `image_url` / `input_image` parts)
   or computer-use tools (`body.tools` entry whose `type` matches /computer/ or whose name
   matches /browser|computer|screenshot|playwright/i) -> `terra`.
2. Hard task (`HARD_TASK` regex from policy.js) or user text longer than `LONG_PROMPT_CHARS` -> `sol`.
   Export both from `src/policy.js` instead of copying them.
3. Writing task (write/draft/rewrite/translate/email/article/docs/README/copy, plus
   撰寫/改寫/翻譯/文章/郵件/文案/摘要) with no code signal -> `terra`.
4. Otherwise `neutral`.

`chooseModel` rules:
- `config.modelMode !== 'auto'` -> that model ("pinned").
- New turn: `sol` affinity -> sol, else terra. But if `prev?.model === 'sol'`, the new choice
  is terra and `bodyBytes > config.downgradeMaxBytes`, stay on sol (switching would re-read
  the whole context uncached).
- Mid-turn: sol stays sol for the rest of the turn (cache). Terra escalates to sol when the
  affinity is not `terra` and (`level === top` or `strong >= 0.6`). A terra-affinity turn
  stays on terra and uses the whole effort ladder.

### Router (owner A): `src/router.js`

`route(body, sessionKey, judgeTarget, turn, { routeModel = false, bodyBytes = 0 } = {})`
returns the existing fields plus:
- `model`: `'terra'|'sol'` when `routeModel`, else `null`
- `fromModel`: the previous model key when it is mid-turn and the key changed, else `null`
- `modelReasons`: string[]
Session state stores `model`. Use the same new-turn test as `nextState` in policy.js
(export a helper rather than duplicating it).

### Decisions (owner A): `src/decisions.js`

Add a `strong` noul question ("Does the NEXT generation need the strongest, most expensive
coding model?") and return `strong` (number) from `toAssessment`. Heuristic and judge
assessments have `strong: undefined` -> pass `null`.

### Proxy (owner B, wave 2): `src/proxy.js`, `src/reasoning.js`, `src/log.js`

- Call `router.route(..., { routeModel: wantsModelRouting(body, config), bodyBytes: raw.length })`.
- When `decision.model`: set `body.model = modelId(decision.model, config, isOpenRouter(base))`
  and use `clampEffort(decision.model, decision.effort)` as the effort sent.
- `config.mode === 'off'` with a routed alias (e.g. `jev-auto`): still rewrite the model
  (pinned model, else terra), leave effort untouched; otherwise upstream gets an unknown model.
- `src/reasoning.js`: `createReasoningTracker(max = 5000)` with
  `record(id, model)`, `observe(event, model)` (records `item.id` of
  `response.output_item.done` events whose `item.type === 'reasoning'`, and `output[]`
  reasoning items of a plain JSON response) and `strip(input, model)` (returns a new input
  array without reasoning items whose recorded model differs; unknown ids are kept).
  Encrypted reasoning from one model must not be replayed to the other. Responses only.
- Hook the tracker into `usageSniffer` (parse each SSE `data:` JSON once, not twice).
- Log record gets `model` (id sent upstream) and `requested` (client's model);
  `stats.byModel`. `/jev/health` identity gets `app: 'jev-sol-terra'`.
- `formatDecision`: `Jev  TERRA·LOW → SOL·XHIGH  ✓ APPLIED` when a model was routed;
  unchanged format otherwise.

### CLI (owner C): `bin/jev.js`, `src/version.js`

- Command name `jev-sol-terra` everywhere (help, messages, version.js stale message).
- Codex profile: file `$CODEX_HOME/jevst.config.toml`, used as `codex -p jevst`,
  with `model = "gpt-6.1-sol"` (a configured id, so the router still picks) and the
  `jevst` provider at `http://host:port/v1`. Marker comment updated.
- `status` / `stop`: a proxy whose health has `app` other than `jev-sol-terra` is not ours:
  report it and never signal it.
- `stats`: group by model and effort (`terra/low`, `sol/xhigh`, ...); old rows without a
  model go under `-`.
- Help lists `JEV_MODEL (auto|terra|sol)`, `JEV_TERRA_MODEL`, `JEV_SOL_MODEL`,
  `JEV_DOWNGRADE_MAX_KB`, port 8788, base URL `http://127.0.0.1:8788/v1`, model `jev-auto`.

## Hard rules

- Touch only the files you own (plus new test files named in your task). Shared files
  (README, package.json, this brief) belong to the lead.
- No `git add/commit/stash/checkout`. No new dependencies. No network calls in tests
  (use local `http.createServer` upstreams like `test/proxy.test.js`).
- Run only your own tests plus `node --test` at the end; tests that start servers use
  port 0 or a free port and close them.
- Do not read credentials (`~/.codex/auth.json`, env keys).

## Done when

Your tests cover every rule above, `node --test` passes, and you report:
files changed, the public functions, test count, anything unverified, open questions.
