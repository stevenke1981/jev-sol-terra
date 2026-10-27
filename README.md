# Jev — 任務中途調整 reasoning effort 的 Codex 路由器

> More thinking when stuck. Less for routine steps.

一般做法是任務開始前選好模型和 effort；Jev 則在 **Codex 任務進行中、每一次 generation 前**
重新決定 `reasoning.effort`：

- 讀檔、列目錄、建置成功這類例行步驟 → `low`
- 指令失敗、連續失敗、重複同一個失敗指令、累積大量讀檔待綜合 → 升到 `medium` / `high`
- 失敗後恢復成功 → 逐級回落（HIGH → MEDIUM → LOW），不一口氣掉到底

Jev 是夾在 Codex 與上游之間的本地 proxy，**只改寫 `reasoning.effort` 一個欄位**，
`instructions`、`tools`、`input` 位元組不變，所以 prompt cache 前綴維持命中。

```
Jev  LOW  ✓ APPLIED
     Step 1 · next 1 generation(s) · 0 ms · first step
Jev  LOW → MEDIUM  ✓ APPLIED
     Step 2 · next 1 generation(s) · 1 ms · exec failed
Jev  MEDIUM → HIGH  ✓ APPLIED
     Step 3 · next 2 generation(s) · 1 ms · 2 failures in a row
Jev  HIGH → MEDIUM  ✓ APPLIED
     Step 5 · next 1 generation(s) · 0 ms · recovered from failures
```

## 安裝與使用

需求：Node.js ≥ 22（零依賴）、Codex CLI（以 0.164.0 驗證）。

```powershell
cd D:\jev
npm link                 # 取得 `jev-effort` 指令（或直接 node bin/jev.js ...）
jev-effort install              # 寫入 ~/.codex/jev.config.toml（Codex 的 `-p jev` profile）
```

兩種用法：

```powershell
# A. 一鍵：背景啟動 proxy，再執行 codex -p jev
jev-effort codex
jev-effort codex exec "inspect this repo and find bugs"

# B. 想像影片一樣看到即時決策：開兩個視窗
jev-effort serve                # 視窗 1：顯示每一步的 Jev 決策
codex -p jev             # 視窗 2：照常使用 Codex
```

其他：`jev-effort tail` 即時追蹤決策、`jev-effort stats` 統計各 effort 的 generation 數與 reasoning tokens。

**更新後記得重啟 proxy。** 執行中的 `jev-effort serve` 不會自動載入新程式碼；舊 proxy 可能做出錯誤的轉送，例如把 `sk-or-` 金鑰送到 OpenAI。`/jev/health` 會回報 `version`、`build`（`src/`、`bin/`、`package.json` 內容的雜湊）、`pid`、`startedAt`：

```powershell
jev-effort status      # 顯示執行中 proxy 的版本，與磁碟上的程式碼比對；過舊或未執行時 exit 1
jev-effort --version   # 磁碟上程式碼的版本與 build
jev-effort stop        # 停止執行中的 proxy（含 `jev-effort codex` 在背景啟動、沒有視窗的那個）
```

`jev-effort codex` 遇到過舊的 proxy 會發出警告，`jev-effort serve` 遇到 port 被占用時，會說明占用的是不是舊版 Jev。

`jev.config.toml` 使用 `requires_openai_auth = true`，沿用 Codex 現有登入：
ChatGPT 登入（JWT / `chatgpt-account-id`）轉送至 `chatgpt.com/backend-api/codex`，
API key（`sk-...`）轉送至 `api.openai.com/v1`。Jev 不讀取、不記錄任何憑證。

## TypeSafe Jev 1.14 決策模式（`openrouter-jev` 分支）

設定 `OPENROUTER_API_KEY` 後，預設改由 OpenRouter 上的
[`typesafe/jev-1.14`](https://openrouter.ai/typesafe/jev-1.14) 決策。這是結構化決策模型，
走 [Decisions API](https://openrouter.ai/docs/guides/community/jev) `POST /api/alpha/decisions`。
每次 generation 前送出本輪軌跡摘要（`state`），並問兩題：

| 題目 | 型別 | 用途 |
|---|---|---|
| `effort` | `score`（量尺即 `JEV_LEVELS`） | 四捨五入後即目標 effort |
| `stuck` | `noul` | ≥0.75 鎖 2 步、≥0.5 鎖 1 步、<0.25 解除鎖定 |

在信心低於 `JEV_MIN_CONFIDENCE`（預設 0.3）、逾時或 HTTP 錯誤時，改用本地 heuristic，不會擋住 Codex。
實測結果：每次約 450–1100 ms、約 $0.00002（只計 input tokens）。

```
Jev  MEDIUM → HIGH  ✓ APPLIED
     Step 3 · next 2 generation(s) · 488 ms · jev score 1.99 (conf 0.98), stuck 0.96
```


## 其他 AI coding 終端（Chat Completions）

Jev 也代理 `POST /v1/chat/completions`，所以 opencode、aider、crush 等走 OpenAI 相容介面的終端，
把 base URL 指到 `http://127.0.0.1:8787/v1` 就能使用。Jev 從 `messages` 中讀出
assistant 的 `tool_calls` 與 `role: "tool"` 回傳，判斷成敗的規則和 Codex 相同。

- **上游**：`sk-or-...` 金鑰轉送至 `openrouter.ai/api/v1`，其他 `sk-...` 金鑰轉送至 `api.openai.com/v1`；
  `JEV_UPSTREAM` 可強制指定。
- **改寫哪個欄位**：請求原本帶 `reasoning_effort` 就改它，帶 `reasoning.effort` 就改那個。
  上游是 OpenRouter 時，即使請求沒帶也會注入 `reasoning: {effort}`，因為 OpenRouter 會忽略模型不支援的參數。
  其他上游若請求沒帶 effort，Jev 只轉送不改，以免不支援推理的模型回 400。
- **Session**：依 `prompt_cache_key`、`user`、`session_id`/`x-session-id` 標頭的順序辨識；
  都沒有時，以 model 加第一則 user 訊息的雜湊區分對話。
- `messages` 原樣轉送，prompt cache 前綴不變。

先在一個視窗執行 `jev-effort serve`，再設定終端：

**opencode**（專案目錄的 `opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "jev": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Jev (OpenRouter)",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": { "deepseek/deepseek-v4.1-flash-1017": { "name": "DeepSeek V4.1 Flash (Jev)" } }
    }
  }
}
```

```powershell
opencode run -m jev/deepseek/deepseek-v4.1-flash-1017 "..."   # 或在 TUI 用 /models 選 Jev
```

若全域設定為 agent 指定了別的模型，專案裡的 `"model"` 會被蓋過，請用 `-m` 明確指定。

**aider**（litellm 的 `openai/` 前綴走 Chat Completions）：

```powershell
$env:OPENAI_API_BASE = "http://127.0.0.1:8787/v1"
$env:OPENAI_API_KEY  = $env:OPENROUTER_API_KEY
aider --model openai/deepseek/deepseek-v4.1-flash-1017
```

**crush**：在 `crush.json` 新增 `"type": "openai-compat"` provider，`base_url` 填 `http://127.0.0.1:8787/v1`。

opencode 1.19.3 實測（DeepSeek V4.1 Flash via OpenRouter，唯讀任務）：

```
Jev  MEDIUM  ✓ APPLIED
     Step 1 · next 1 generation(s) · 0 ms · hard task, planning
Jev  MEDIUM → LOW  ✓ APPLIED
     Step 2 · next 1 generation(s) · 0 ms · routine tool
```

reasoning tokens：MEDIUM 183、LOW 83。session 為 opencode 自己的 `ses_...` id。

本分支的 `jev` 模式同樣適用於 Chat Completions。以上述同一個 opencode 任務實測，4 次 generation 都由 Jev 1.14 判為 LOW（score 0.02–0.08，conf 0.88–0.97），每次 548–1313 ms。

## 設定（環境變數）

| 變數 | 預設 | 說明 |
|---|---|---|
| `JEV_PORT` / `JEV_HOST` | `8787` / `127.0.0.1` | 監聽位址（改 port 後需重跑 `jev-effort install`） |
| `JEV_LEVELS` | `low,medium,high` | effort 階梯，可用 `minimal`…`xhigh`，例：`low,medium,high,xhigh` |
| `JEV_MODE` | 有 key 時 `jev`，否則 `heuristic` | `jev`（TypeSafe Jev 1.14）、`heuristic`（0 ms 規則）、`llm`（小模型判官）、`off`（純轉送） |
| `OPENROUTER_API_KEY` | — | `jev` 模式必填 |
| `JEV_DECISION_MODEL` | `typesafe/jev-1.14` | 可改 `~typesafe/jev-latest` 或 `typesafe/jev-1.13` |
| `JEV_MIN_CONFIDENCE` | `0.3` | Jev `effort` 信心低於此值就改用 heuristic |
| `JEV_JUDGE_MODEL` | 同請求模型 | `llm` 模式的判官模型 |
| `JEV_JUDGE_TIMEOUT_MS` | `2500` | 判官逾時即退回規則 |
| `JEV_UPSTREAM` | 依憑證自動 | 強制指定上游 base URL |
| `JEV_OPENROUTER_UPSTREAM` | `https://openrouter.ai/api/v1` | `sk-or-` 金鑰的上游 |
| `JEV_HOME` | `~/.jev` | `decisions.jsonl`、`proxy.log` 位置 |
| `JEV_QUIET` | — | `1` 則不印決策 |

## 架構

| 檔案 | 職責 |
|---|---|
| `src/trajectory.js` | 從 Responses `input` 擷取本輪（最後一則真人訊息之後）的工具呼叫與成敗 |
| `src/policy.js` | `assess()` 判斷目標 effort；`nextState()` 加上鎖定（hold）與逐級回落 |
| `src/chat.js` | Chat Completions：從 `messages` 擷取本輪軌跡、改寫或注入 effort、辨識 session |
| `src/judge.js` | 選用的 LLM 判官 |
| `src/router.js` | 依 `prompt_cache_key` 保存各 session 狀態 |
| `src/version.js` | 版本與 build 指紋；`compareBuild()` 判斷執行中的 proxy 是否過舊 |
| `src/proxy.js` | HTTP proxy：解壓（zstd/gzip/br）、改寫 effort、串流回傳、擷取 usage |
| `bin/jev.js` | CLI |

## 限制

- 決策列印在 proxy 視窗，而非 Codex TUI 內（不修改 Codex 本體）。
- 支援 HTTP 的 Responses 與 Chat Completions；Codex 的 websocket 傳輸不經過 Jev。
- Chat Completions 請求不使用 `llm` 判官（判官走 Responses API），改用 heuristic。
- aider 預設以文字 edit block 修改檔案，不經 tool call，因此 Jev 只能依 user 訊息判斷，例如 aider 自動送回的 lint 或測試錯誤。
- 「省 50% 成本」為原貼文作者的數據；Jev 實際節省幅度請以 `jev-effort stats` 於自身工作量量測。

## 測試

```powershell
npm test     # node --test：policy、trajectory、proxy（含 zstd、judge 退回）、chat
```

## 變更歷史

| 版本 | 日期 | 內容 | 影響範圍 |
|------|------|------|----------|
| v0.5.0 | 2026-10-27 | 新增 `jev-effort stop`：依 `/jev/health` 回報的 PID 停止 proxy，並等到 port 釋放；太舊、不回報 PID 的 proxy 會提示手動停止的指令 | bin |
| v0.4.0 | 2026-10-27 | 新增版本檢查：`/jev/health` 回報 version/build/pid/startedAt；新增 `jev-effort status`、`--version`；`codex` 與 `serve` 偵測過舊的 proxy | version, proxy, bin |
| v0.3.0 | 2026-10-27 | 新增 `/chat/completions` 代理，供 opencode、aider、crush 使用；`sk-or-` 金鑰自動走 OpenRouter；`stats` 支援 chat usage；以 opencode 1.19.3 實測 | chat, proxy, router, config, log, bin |
| v0.2.0 | 2026-10-27 | 新增 `jev` 模式：OpenRouter Decisions API + `typesafe/jev-1.14`（score/noul），失敗時改用 heuristic；`stats` 顯示 Jev 費用 | config, router, decisions, bin |
| v0.1.0 | 2026-10-27 | 初始建立：heuristic/LLM 路由、hysteresis、proxy、CLI、測試；並修正獨立審查所列問題（搜尋無匹配不算失敗、圖片訊息、SSE 背壓、URL 來源檢查、Windows 不經 shell 啟動 codex） | 全部 |
