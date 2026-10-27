# jev-sol-terra — GPT-6.1 Terra／Sol 與 reasoning effort 路由器

> 每一次 generation 都重新決定「用哪個模型」與「用多少 reasoning」。
> **Sol：困難的程式碼、深入的問題。Terra：確實執行交代的事情、computer use。**

本專案衍生自 [jev](https://github.com/stevenke1981/jev)（`openrouter-jev` 分支，97b9289），沿用其 effort 路由、hysteresis 與 TypeSafe Jev 決策，並新增 **模型路由**：每次 generation 在 `gpt-6.1-terra` 與 `gpt-6.1-sol` 之間擇一，同時決定 effort。

- 困難程式碼（設計、重構、除錯、並行、安全…）與深入問題（原理、分析、比較、權衡、演算法、how does…）→ Sol
- 交代清楚的事（改名、新增、更新、安裝、執行，或列出 3 步以上的步驟）→ Terra 照做；卡住才升 Sol
- 圖片、computer use、寫作翻譯 → Terra
- 讀檔、列目錄、建置成功這類例行步驟 → effort `low`
- 指令失敗、重複同一個失敗、難題、長程任務 → 升 effort，必要時改用 Sol
- 失敗後恢復成功 → 逐級回落，不一口氣掉到底

## 功能概覽

proxy 位於 Codex 或 Chat Completions 客戶端與上游之間，只在需要時改寫請求。

| key | model id | API 價格 /1M（input / cached / output） | effort | 擅長 |
|---|---|---|---|---|
| `terra` | `gpt-6.1-terra` | $1 / $0.05 / $5 | none, low…max | 快、便宜；視覺推理、computer use、寫作 |
| `sol` | `gpt-6.1-sol` | $2 / $0.10 / $10 | low…max（無 none／minimal） | 困難的程式、長程 agent 任務 |

effort 階梯預設 `low → medium → high → xhigh`（`JEV_LEVELS` 可改）。

改寫範圍：只改 `model`（僅路由時）與 effort（Responses 為 `reasoning.effort`，Chat 為原本帶的 `reasoning_effort` 或 `reasoning.effort`）。`instructions`、`tools`、`input` 其餘內容不變；唯一例外是路由到另一模型時，會移除另一模型產生的 reasoning item（見「加密 reasoning item」）。

```
Jev  TERRA·LOW → SOL·XHIGH  ✓ APPLIED
```

## 安裝與使用

需求：Node.js ≥ 22.15（零依賴）、Codex CLI，或任一 Chat Completions 客戶端。

新電腦從 GitHub 安裝：

```powershell
git clone https://github.com/stevenke1981/jev-sol-terra.git
cd jev-sol-terra                 # 一定要在這個資料夾執行 npm link
npm link                         # 註冊全域指令 jev-sol-terra（或不 link，直接 node bin/jev.js ...）
jev-sol-terra --version          # 確認：jev-sol-terra v0.2.x
jev-sol-terra install            # 寫入 $CODEX_HOME/jevst.config.toml（預設 ~/.codex）
```

更新：在 `jev-sol-terra` 資料夾執行 `git pull`，再執行 `jev-sol-terra stop` 停掉舊 proxy。`npm link` 是指向資料夾的連結，所以不必重新 link。

> **找不到指令？** PowerShell 顯示「無法將 'jev-sol-terra' 字詞辨識為 Cmdlet…」，通常是在別的資料夾執行了 `npm link`。例如在原本的 [jev](https://github.com/stevenke1981/jev) 專案中執行，註冊的會是 `jev-effort`，不是 `jev-sol-terra`。請 `cd` 到本專案資料夾再執行一次 `npm link`，再用 `Get-Command jev-sol-terra` 確認。若仍找不到，請確認 `npm prefix -g`（Windows 通常是 `%APPDATA%\npm`）已加入 PATH，並重開終端機。

`install` 寫入的 Codex profile：`model = "gpt-6.1-sol"`（已設定的 id，所以 proxy 會逐次路由）、`jevst` provider 指向 `http://127.0.0.1:8788/v1`、`wire_api = "responses"`。檔案若存在且不是本工具寫入的，會拒絕覆寫，需加 `--force`。

兩種用法：

```powershell
# A. 一鍵：背景啟動 proxy，再執行 codex -p jevst
jev-sol-terra codex
jev-sol-terra codex exec "inspect this repo and find bugs"

# B. 即時看決策：開兩個視窗
jev-sol-terra serve              # 視窗 1：顯示每一步的決策
codex -p jevst                   # 視窗 2：照常使用 Codex
```

其他指令：

| 指令 | 用途 |
|---|---|
| `jev-sol-terra serve` | 前景執行 proxy（預設 `127.0.0.1:8788`） |
| `jev-sol-terra install [--force]` | 寫入 `jevst` profile |
| `jev-sol-terra codex [args...]` | 必要時啟動 proxy，再執行 `codex -p jevst [args...]` |
| `jev-sol-terra tail` | 即時追蹤決策（讀 `decisions.jsonl`） |
| `jev-sol-terra stats` | 依 model／effort 分組：`terra/low`、`sol/xhigh`…；舊資料無 model 者歸 `-` |
| `jev-sol-terra status` | 顯示執行中 proxy 的版本；過舊或未執行時 exit 1 |
| `jev-sol-terra stop` | 停止執行中的 proxy（含 `codex` 在背景啟動者） |
| `jev-sol-terra --version` | 磁碟上程式碼的版本與 build |

**更新後請重啟 proxy。** 執行中的舊 proxy 不會自動載入新程式碼。`/jev/health` 會回報 `app`、`version`、`build`（`src/`、`bin/`、`package.json` 的雜湊）、`pid`、`startedAt`、`mode`、`ladder` 與 `stats`（含 `byModel`、`byEffort`）。`status` 與 `codex` 會偵測過舊的 proxy。

`stop` 只會停止 `app` 為 `jev-sol-terra` 的 proxy。埠口若被其他程式占用，會回報而不發出訊號。

**與 jev-effort 並存：** 預設埠 8788（jev-effort 為 8787）、home 為 `~/.jev-sol-terra`（jev-effort 為 `~/.jev`）、Codex profile 為 `jevst`（jev-effort 為 `jev`），兩者可同時執行。

**憑證：** proxy 只依標頭判斷上游，不寫入憑證到記錄。上游選擇順序：`JEV_UPSTREAM` 強制指定；ChatGPT 登入（JWT 或 `chatgpt-account-id`）→ `chatgpt.com/backend-api/codex`；`sk-or-` 金鑰 → `openrouter.ai/api/v1`；其他 → `api.openai.com/v1`。

## 平行代理模式（預設，`JEV_AGENTS=parallel`）

Codex 的 multi-agent 功能（`multi_agent`，預設開啟）可以讓主代理派出多個平行子代理。proxy 依請求 header 分辨角色：

| 角色 | 判斷方式 | 起始 | 之後 |
|---|---|---|---|
| 主代理（規劃、困難判斷） | 沒有子代理 header | **Sol·LOW** | 一直留在 Sol；卡住時 effort 逐級升到 xhigh |
| 子代理（執行交代的工作） | `x-codex-parent-thread-id` 或 `x-openai-subagent`（`thread_spawn`、`compact`、`review`…） | **Terra·LOW** | 卡住時先升 effort，再依「卡住升 Sol」規則換成 Sol；computer use、圖片、寫作類整輪留在 Terra |

- 每個代理有自己的 `prompt_cache_key`，因此各自獨立追蹤、獨立升降，互不影響。
- 兩種角色都從 low 開始（單一代理模式下困難任務會從 medium 開始），之後才依情況加 effort。
- 其他客戶端（opencode、自製 agent）可在請求加上 header `x-jev-role: main` 或 `x-jev-role: worker` 指定角色。這個 header 不會轉送給上游。
- `JEV_MODEL=terra|sol` 仍優先：會固定模型，不看角色。
- `JEV_AGENTS=single`：回到 v0.2 的行為，不看角色、只依任務內容挑模型（見下節）。
- 沒有子代理 header 的 Chat Completions 客戶端，每個請求都算主代理，因此一律走 Sol。只想讓這類客戶端依任務挑模型的話，請用 `JEV_AGENTS=single`。
- decisions log 多一個 `role` 欄位（`main`／`worker`）。

## 模型路由規則（`JEV_AGENTS=single`；平行模式的子代理也沿用其中「卡住升 Sol」的部分）

路由分兩層：先判斷任務特徵（`taskProfile`），再決定本代用哪個模型（`chooseModel`）。

### 1. 任務特徵（先命中者優先）

1. 本輪（最後一則真人訊息之後）含圖片（`input_image`／`image_url`）→ `terra`
2. 提供內建 computer-use 工具（`tools` 的 type 含 `computer`），或本輪實際呼叫過名稱含 `browser`、`computer`、`screenshot`、`playwright` 的工具 → `terra`。MCP 瀏覽器工具只有本輪真的呼叫過才算，避免每個 session 都掛載時被誤判。
3. 困難程式碼（`HARD_TASK`：design、refactor、debug、race、security、why、root cause、設計、重構、除錯、根因…）→ `sol`
4. 深入問題（`DEEP_QUESTION`：how does、explain how/why、trade-off、algorithm、complexity、analyze、compare、深入、原理、分析、比較、權衡、取捨、演算法、推導、怎麼運作…）→ `sol`
5. 列出 3 行以上編號或項目符號的步驟 → `neutral`（理由 `clear instructions (N steps)`）。使用者已規劃好，交給 Terra 照做，即使內容很長也一樣。
6. 使用者文字超過 `LONG_PROMPT_CHARS`（600）→ `sol`
7. 具體指令（以 add、rename、move、delete、update、install、run、create、set、change、list…開頭，或 請／幫我 新增、改名、刪除、更新、安裝、執行、依照…，或「把 X 改成 Y」）→ `neutral`（理由 `clear instructions`）
8. 寫作類（write、draft、rewrite、translate、email、article、docs、readme，或 撰寫、改寫、翻譯、文章、郵件、文案、摘要）且無程式訊號 → `terra`；寫作中夾帶程式訊號 → `neutral`
9. 其餘 → `neutral`

`neutral` 先用 Terra，只有卡住時才升 Sol（見下節）；`terra` 任務（圖片、computer use、寫作）整個 turn 都留在 Terra。

### 2. 每代模型（`chooseModel`）

- `JEV_MODEL=terra|sol`：固定該模型，effort 仍照常路由。
- **新 turn**：`sol` 任務 → `sol`；其餘 → `terra`。例外：上一代為 `sol`、本次判為 `terra`，但解碼後的 body 大於 `JEV_DOWNGRADE_MAX_KB`（預設 64 KB）→ 留在 `sol`。理由：換模型會讓整段 context 無法命中 prompt cache，全部重讀。
- **turn 中**，依序判斷：
  1. 上一代為 `sol` → `sol`。同一 turn 內保留 sol，因為 cache 以模型分開。
  2. `terra` 任務 → `terra`，可使用完整 effort 階梯。
  3. 非 `terra` 任務，且 effort 已到階梯頂端 → `sol`。
  4. 非 `terra` 任務，且 Jev 的 `strong` ≥ 0.6 → `sol`。
  5. 非 `terra` 任務，且 Jev 的 `stuck` ≥ 0.9，同時本代與上一代的 effort 都在次高階以上（預設即 `high` 或 `xhigh`）→ `sol`（理由寫為 `still stuck … at second rung`）。
  6. 其餘 → `terra`。
- `strong` 只來自 Jev 決策（jev 模式）；heuristic 與 judge 模式下為 `null`，第 4 條不觸發。

### 3. 客戶端如何選擇路由

| 客戶端設定 | 效果 |
|---|---|
| model `jev-auto`（或 `auto`，見 `JEV_AUTO_MODELS`） | 模型與 effort 都路由 |
| model `gpt-6.1-terra`、`gpt-6.1-sol`，或 `openai/` 加上述 id | 同上（Codex profile 即使用 `gpt-6.1-sol`） |
| 其他 model 名稱 | 只路由 effort，model 不改寫 |
| `JEV_MODE=off` 且 model 為 `jev-auto` | effort 不動；model 改為固定模型，未固定則為 `terra` |

送出前會把 effort 對齊到該模型可用的值：`sol` 的 `none`／`minimal` → `low`，`terra` 的 `minimal` → `low`。預設階梯不含這些值，所以通常不會觸發。

### 4. 加密 reasoning item（僅 Responses）

Encrypted reasoning item 只能由產生它的模型讀取。proxy 會記錄每個 reasoning item id 由哪個上游模型產生（來源：串流的 `response.output_item.done`，以及非串流 JSON 的 `output` 陣列），並在下一個 **路由到不同模型** 的 Responses 請求中移除外來的 item。

- 未見過的 id 會保留（客戶端可能帶著本 proxy 啟動前的 item）。
- 最多記住 5000 個 id，超過時淘汰最舊者。
- Chat Completions 沒有此問題，不做處理。

## TypeSafe Jev 決策模式（預設）

設定 `OPENROUTER_API_KEY` 後，預設 `JEV_MODE=jev`，由 OpenRouter 上的 [`typesafe/jev-1.14`](https://openrouter.ai/typesafe/jev-1.14) 決策，走 Decisions API `POST /api/alpha/decisions`。每次 generation 前送出本輪軌跡摘要（`state`），並問：

| 題目 | 型別 | 用途 |
|---|---|---|
| `effort` | `score`（量尺即 `JEV_LEVELS`） | 四捨五入後即目標 effort |
| `stuck` | `noul` | 卡關程度，供 effort 鎖定與模型升級使用 |
| `strong` | `noul` | 「下一代是否需要最強、最貴的 coding 模型」，供升 Sol 使用 |

信心低於 `JEV_MIN_CONFIDENCE`（預設 0.3）、逾時或 HTTP 錯誤時，改用本地 heuristic，不會擋住客戶端。

## 實測（OpenRouter，jev 模式，2026-10-27）

單句提問：

| 輸入 | 結果 |
|---|---|
| "Say hi in 3 words." | TERRA·LOW（no strong signal） |
| 死鎖根因提問 | SOL·LOW（hard task） |
| "Translate to French…" | TERRA·LOW（writing task） |

Chat Completions 多輪：同一個失敗的 pytest tool result 重複回傳時，依序為：

```
TERRA·LOW → TERRA·MEDIUM (stuck 0.37) → TERRA·HIGH (stuck 0.96) → SOL·HIGH (stuck 0.97, "still stuck at second rung")
```

Jev 每次決策延遲 548–765 ms。

Responses API（OpenRouter）：同一 session 先問 "What is 17*23?" → TERRA·LOW，再問死鎖根因 → SOL·LOW，模型跨輪切換後回應正常。（上述為 `JEV_AGENTS=single` 時期的結果。）

平行代理模式（v0.3.0，Responses API，三個請求同時送出）：

| 代理 | 請求 | 結果 |
|---|---|---|
| 主代理 | 規劃如何把重構拆成兩個平行任務（Jev 分數 0.85，原本會是 medium） | SOL·LOW（main starts low） |
| 子代理 1（`thread_spawn`） | 把變數 cnt 改名為 count | TERRA·LOW |
| 子代理 2（`thread_spawn`） | 死鎖原因（單一模式下會走 Sol） | TERRA·LOW，答案正確 |

## Chat Completions 客戶端

proxy 也代理 `POST /v1/chat/completions`。opencode、aider、crush 等 OpenAI 相容客戶端，把 base URL 指到 `http://127.0.0.1:8788/v1`，model 設為 `jev-auto` 即可。

- **上游**：`sk-or-` 金鑰 → OpenRouter，且 model id 自動加 `openai/` 前綴（例如 `openai/gpt-6.1-sol`）；其他 `sk-` 金鑰 → `api.openai.com/v1`；`JEV_UPSTREAM` 可強制指定。
- **改寫哪個欄位**：請求已帶 `reasoning_effort` 或 `reasoning.effort` 時改它。上游為 OpenRouter 時，即使請求沒帶也會注入 `reasoning: {effort}`，因為 OpenRouter 會忽略模型不支援的參數。其他上游若沒帶 effort，只轉送不改，避免不支援推理的模型回 400。
- **Session**：依 `prompt_cache_key`、`user`、`session_id`／`x-session-id` 標頭的順序辨識；都沒有時，以 model 加第一則 user 訊息的雜湊區分對話。
- `messages` 原樣轉送，prompt cache 前綴不變。
- 工具成敗判斷與 Codex 相同：讀取 assistant 的 `tool_calls` 與 `role: "tool"` 回傳。

以下設定依 proxy 行為撰寫，**本專案尚未以這些客戶端實測**。

**opencode**（專案目錄的 `opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "jev": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "jev-sol-terra (OpenRouter)",
      "options": { "baseURL": "http://127.0.0.1:8788/v1", "apiKey": "{env:OPENROUTER_API_KEY}" },
      "models": { "jev-auto": { "name": "GPT-6.1 Terra/Sol auto" } }
    }
  }
}
```

```powershell
opencode run -m jev/jev-auto "..."      # 或在 TUI 用 /models 選擇
```

若全域設定為 agent 指定了其他模型，專案裡的 `"model"` 會被蓋過，請用 `-m` 明確指定。

**aider**（litellm 的 `openai/` 前綴走 Chat Completions）：

```powershell
$env:OPENAI_API_KEY = $env:OPENROUTER_API_KEY
aider --openai-api-base http://127.0.0.1:8788/v1 --model openai/jev-auto
```

**crush**：在 `crush.json` 新增 `"type": "openai-compat"` 的 provider，`base_url` 填 `http://127.0.0.1:8788/v1`，model 填 `jev-auto`。

## 設定（環境變數）

| 變數 | 預設 | 說明 |
|---|---|---|
| `JEV_PORT` / `JEV_HOST` | `8788` / `127.0.0.1` | 監聽位址 |
| `JEV_MODEL` | `auto` | `auto` 依任務路由；`terra`／`sol` 固定模型 |
| `JEV_TERRA_MODEL` | `gpt-6.1-terra` | Terra 的 model id |
| `JEV_SOL_MODEL` | `gpt-6.1-sol` | Sol 的 model id |
| `JEV_AUTO_MODELS` | `jev-auto,auto` | 會觸發模型路由的 client model 名稱 |
| `JEV_DOWNGRADE_MAX_KB` | `64` | 新 turn 由 sol 降回 terra 的解碼後 body 上限 |
| `JEV_LEVELS` | `low,medium,high,xhigh` | effort 階梯，可用 `none`…`max` |
| `JEV_MODE` | 有 `OPENROUTER_API_KEY` 時 `jev`，否則 `heuristic` | `jev`（TypeSafe Jev 1.14）、`heuristic`（0 ms 規則）、`llm`（小模型判官）、`off`（純轉送） |
| `OPENROUTER_API_KEY` | — | `jev` 模式必填；`sk-or-` 金鑰也決定 OpenRouter 上游 |
| `JEV_DECISION_MODEL` | `typesafe/jev-1.14` | Jev 決策模型 |
| `JEV_DECISION_URL` | `https://openrouter.ai/api/alpha/decisions` | Decisions API 位址 |
| `JEV_MIN_CONFIDENCE` | `0.3` | Jev 信心低於此值就改用 heuristic |
| `JEV_JUDGE_MODEL` | 同請求模型 | `llm` 模式的判官模型 |
| `JEV_JUDGE_EFFORT` | `low` | 判官的 reasoning effort |
| `JEV_JUDGE_TIMEOUT_MS` | `2500` | 判官逾時即退回規則 |
| `JEV_UPSTREAM` | 依憑證自動 | 強制指定上游 base URL |
| `JEV_CHATGPT_UPSTREAM` | `https://chatgpt.com/backend-api/codex` | ChatGPT 登入的上游 |
| `JEV_API_UPSTREAM` | `https://api.openai.com/v1` | API key 的上游 |
| `JEV_OPENROUTER_UPSTREAM` | `https://openrouter.ai/api/v1` | `sk-or-` 金鑰的上游 |
| `JEV_HOME` | `~/.jev-sol-terra` | `decisions.jsonl`、`proxy.log` 位置 |
| `JEV_QUIET` | — | `1` 則不印決策 |
| `CODEX_HOME` | `~/.codex` | `install` 寫入 profile 的目錄 |

## 架構

| 檔案 | 職責 |
|---|---|
| `src/config.js` | 讀取環境變數、驗證設定、`MODEL_KEYS` 與 `EFFORTS` |
| `src/model.js` | `taskProfile()` 任務特徵；`chooseModel()` 每代模型；`wantsModelRouting()`、`modelId()`、`clampEffort()` |
| `src/policy.js` | effort 判斷 `assess()`、hysteresis 與逐級回落 `nextState()`；`HARD_TASK`、`LONG_PROMPT_CHARS` |
| `src/decisions.js` | Jev 決策（OpenRouter Decisions API），含 `strong` 問題 |
| `src/trajectory.js` | 從 Responses `input` 擷取本輪的工具呼叫與成敗 |
| `src/chat.js` | Chat Completions：從 `messages` 擷取軌跡、改寫 effort、辨識 session |
| `src/judge.js` | 選用的 LLM 判官（僅 Responses） |
| `src/router.js` | 依 session 保存狀態（`effort`、`model`）；合併 effort 與模型決策 |
| `src/reasoning.js` | 記錄 reasoning item 的模型歸屬，移除另一模型的 item |
| `src/proxy.js` | HTTP proxy：解壓（zstd／gzip／br）、改寫請求、串流回傳、擷取 usage、`/jev/health` |
| `src/log.js` | 決策記錄（`decisions.jsonl`）與終端機格式 |
| `src/version.js` | 版本與 build 指紋；判斷執行中的 proxy 是否過舊 |
| `bin/jev.js` | CLI |

## 限制與未驗證事項

- **未驗證**：Codex 以 ChatGPT 登入、使用這些 model id 的情況尚未測試。
- **未驗證**：未經真正的 OpenAI 端點測試。OpenRouter 上 Chat Completions 與 Responses 都已實測（Responses：同 session 第一輪 TERRA·LOW，下一輪改問困難題換成 SOL·LOW，兩次皆 completed）；但 low effort 下上游未回傳 reasoning item，所以 reasoning item 隔離只由本機測試涵蓋。
- **未驗證**：跨模型重放 encrypted reasoning 假設會被上游拒絕，因此移除外來的 item。
- Chat Completions 不使用 `llm` 判官（判官走 Responses API），改用 heuristic，與 jev 相同。
- 寫作與 computer use 的判斷為 regex 啟發式，可能誤判；可用 `JEV_MODEL` 固定模型避開。
- 決策列印在 proxy 視窗，而非 Codex TUI 內（不修改 Codex 本體）。
- 支援 HTTP 的 Responses 與 Chat Completions；Codex 的 websocket 傳輸不經過 proxy。
- aider 預設以文字 edit block 修改檔案，不經 tool call，因此 proxy 只能依 user 訊息判斷，例如 aider 送回的 lint 或測試錯誤。
- 省成本幅度請以 `jev-sol-terra stats` 於自身工作量量測，不採信外部數據。

## 測試

```powershell
npm test     # node --test，113 個測試；不連網路，上游以本機 http.createServer 模擬
```

## 變更歷史

| 版本 | 日期 | 內容 | 影響範圍 |
|------|------|------|----------|
| v0.3.0 | 2026-10-27 | 平行代理模式（預設）：主代理 Sol·LOW 起步，Codex 子代理（`x-codex-parent-thread-id`／`x-openai-subagent`）Terra·LOW 起步、卡住才升 Sol；`x-jev-role` header；`JEV_AGENTS=single` 恢復 v0.2 行為；log 新增 `role` | `src/model.js`、`src/router.js`、`src/proxy.js`、`src/config.js` |
| v0.2.0 | 2026-10-27 | 調整模型分工：深入問題（原理、分析、比較、權衡…）改走 Sol，effort 起始 medium；具體指令與列明步驟的長需求改由 Terra 先做，卡住才升 Sol | `src/model.js`、`src/policy.js` |
| v0.1.0 | 2026-10-27 | 初始建立（衍生自 jev `openrouter-jev` 97b9289）：GPT-6.1 Terra／Sol 模型路由與 effort 路由、TypeSafe Jev 決策（含 `strong`）、Chat Completions 代理、加密 reasoning item 隔離、CLI（serve、install、codex、tail、stats、status、stop） | 全部 |
