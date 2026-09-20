<div align="center">

<img src="assets/umiro-header.png" alt="ümiro" width="700">

[English](README.md) · **繁體中文**

**可自行託管的 Discord 個人 AI agent，具備可持久化的執行核心。**

[![node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/iiimabbie/umiro-agent/releases/tag/v0.1.0)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

ümiro 在你的 Discord 伺服器裡以同一個人格運作。每一段對話、每一次工具呼叫與回覆都記錄在 SQLite，所以 agent 在任務中途重啟也能接續、記得說過的話、事後可以稽核——而模型端點、資料與權限都由你掌控。

> [!WARNING]
> ümiro 能執行 shell 指令並操作已連接的服務。只在你信任的主機與 Discord 伺服器上執行，開放給其他人使用前請先檢視權限設定。

## 功能

| | |
|---|---|
| **原生 Discord** | 提及、回覆、私訊、討論串與論壇貼文；slash 指令；每個頻道可設定忽略／觀察／回應 |
| **可持久化執行** | Conversation → Turn → Run → Step → Operation 全在 SQLite；每個 Run 可獨立崩潰恢復、等待核准、取消 |
| **會長大的記憶** | 五份結構化記憶檔分級載入；所有過往發言與工具結果可全文搜尋；可選用 embedding 做語意回憶 |
| **權限** | Owner 與一般成員兩級；每個工具宣告 capability 與 tier；委派時權限只會縮小 |
| **子代理** | 每個主管最多兩個並行子 Run、只有一層，可取消、可先回覆；profile 由外掛提供 |
| **排程** | 可持久化的 cron 與一次性提醒，以一般 agent Run 的方式執行 |
| **外掛系統** | 內掛與外掛共用同一套 manifest 與 runtime；外掛可從 GitHub 安裝、啟用、設定、更新、移除 |
| **控制台** | 本機網頁介面：像聊天紀錄一樣讀對話、管理外掛、排程、workspace 檔案與設定 |

## 需求

- Linux，Node.js 24 以上，pnpm（經 Corepack）
- Discord bot token 與你的 Discord 使用者 ID
- OpenAI 相容的模型端點（Responses 或 Chat Completions）

## 快速開始

```bash
git clone https://github.com/iiimabbie/umiro-agent.git
cd umiro-agent
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
pnpm umo install
export PATH="$HOME/.umiro/bin:$PATH"
```

一般安裝不需要設定 `UMIRO_HOME`；以上指令會安裝到目前使用者自己的 `~/.umiro`。

啟動 daemon，再開啟本機設定介面：

```bash
umo start
umo web token
umo status
```

`umo start` 會印出 Web UI 位址（預設為 `http://127.0.0.1:3210`）。在模型端點、模型、Discord token 與 Owner ID 設定完成前，gateway 會維持在設定模式。使用 `umo web token` 印出的 token 登入。

自動化或無頭環境仍可在啟動前匯入憑證：

```bash
cp .env.example .env
$EDITOR .env
umo configure --from-env .env
umo start
```

第一次接觸時，agent 會帶 Owner 走一段簡短的設定：名字、語氣、怎麼稱呼你。`SOUL.md` 與 `OWNER.md` 填好後，設定流程會自行移除。

> [!IMPORTANT]
> 不要讓本專案與前一代 ümiro 同時使用同一個 Discord token，兩個程序會搶同一條事件流。

## 設定

所有東西都在同一個安裝根目錄，預設 `~/.umiro/`（可用 `UMIRO_HOME` 覆寫）。

| 路徑 | 用途 |
|---|---|
| `bin/umo` | 管理 CLI |
| `app/releases/`、`app/current` | 版本化 release 與目前使用中的那份 |
| `config/umiro.json` | 模型、Discord、embedding 與網頁介面設定 |
| `config/secrets.env` | token 與 API 金鑰，權限 `0600` |
| `workspace/` | agent 的身分與記憶，見下 |
| `data/umiro.sqlite` | 對話、Run、搜尋索引、向量 |
| `state/` | service 單元、程序狀態、log |

### 憑證

```dotenv
DISCORD_TOKEN=
UMIRO_OWNER_DISCORD_ID=
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

請將 `LLM_BASE_URL` 設為你的 OpenAI 相容端點，並將 `LLM_MODEL` 設為該端點提供的模型；使用 `umo configure` 匯入時會要求兩者都有值，也可以啟動後從 Web UI 完成設定。

### Workspace

Workspace 是純 Markdown，agent 每次執行都會讀，並透過工具編輯。

| 檔案 | 角色 |
|---|---|
| `SOUL.md` | 她是誰：名字、語氣、價值觀、界線 |
| `AGENT.md` | 她怎麼做事：資訊該放哪、驗證、委派、安全 |
| `OWNER.md` | 她為誰服務，以及你的長期指示 |
| `memory/PREFERENCES.md`、`memory/LESSONS.md` | 每次執行整份載入 |
| `memory/WORKFLOWS.md`、`memory/ONGOING.md`、`memory/FACTS.md` | 只載入標題；內容需要時撈取或由搜尋自動帶入 |
| `skills/<name>/SKILL.md` | 可選的技能；在 `config/umiro.json` 啟用 |

### Discord

```bash
umo discord configure --allowed-guilds <id,...> --allowed-channels <id,...> \
  --ambient-channels <id,...> --ignored-channels <id,...> \
  --respond-to-bots false --queue-mode queue
umo discord status
```

Discord 內的 slash 指令：`/new` 在本頻道開新對話（目前這段封存）、`/stop` 取消進行中的 Run、`/model` 與 `/queue` 調整本 session。

### 語意搜尋

全文搜尋開箱即用；embedding 需自行啟用：

請在控制台的 Embedding 區一起設定 provider、model、URL 與 API Key；它們會分別以 embedding 設定與 secrets 儲存。使用 `openai-compatible` 時，`UMIRO_EMBEDDING_BASE_URL` 與 `UMIRO_EMBEDDING_API_KEY` 都是必要的 secrets。

```bash
umo embedding configure --provider gemini --model gemini-embedding-2
umo embedding configure --provider openai-compatible \
  --model nomic-embed-text --base-url http://localhost:11434/v1
umo embedding status
```

## 控制台

```bash
umo web token     # 印出存取 token
umo web status
```

控制台只綁 loopback（預設 `http://127.0.0.1:3210`）。可以看每個頻道目前的對話與封存的對話（聊天紀錄形式），以及外掛、排程、workspace 檔案、設定、用量與 log。

## 內掛 / 外掛

內掛隨 release 出貨，可停用但不可移除：`context-files`、`memory`、`scheduler`、`subagent`、`host-tools`、`discord-tools`。不裝任何外掛，ümiro 已是完整的 agent。

外掛另行安裝，官方集合在 [umiro-plugins](https://github.com/iiimabbie/umiro-plugins)：

| 外掛 | 功能 |
|---|---|
| `people` | 記錄 agent 遇到的人，出現時附進 prompt |
| `soul-guardian` | 定期檢查 `SOUL.md` 與 `AGENT.md` 是否被改動，一鍵還原 |
| `coder` | 寫程式用的子代理 profile |
| `google` | Gmail、Calendar、Tasks、Drive 工具，OAuth 授權 |
| `tool-activity` | Run 使用工具時，在 Discord 即時顯示她正在做什麼 |
| `daily-report` | 排程的每日摘要 |
| `diary` | 從 canonical conversation history 重建 agent 自己第一人稱的每日日記 |
| `intent-analyzer` | 可選的回應意圖與模型可見工具分析 |

```bash
umo plugin install https://github.com/iiimabbie/umiro-plugins.git --workspace people
umo plugin list
umo plugin enable | disable | update | remove <source>
umo plugin remove <source> [--workspace <name>] --remove-secrets
umo plugin configure <source> --config '{"key":"value"}'
```

內掛與外掛共用同一套 manifest、權限、生命週期與 runtime。外掛宣告需要的 capability，host 會把它限制在呼叫者本身被允許的範圍內。

停用外掛時，它註冊的工具、policy、hook、job、command、skill 與搜尋 projection 會從 runtime 撤下，所屬排程會標記為生命週期停用；再次啟用時才恢復。移除外掛時，所屬排程與搜尋 projection 會一併刪除。外掛執行後產生的日記、報告等使用者資料會保留。

停用外掛永遠保留它宣告的 Secret；移除外掛預設也保留。控制台的移除 modal 可以明確勾選同時清理 Secret。CLI 用 `umo plugin remove <source> [--workspace <name>] --remove-secrets`；只會刪除目標外掛宣告、且只由它獨占的 Secret。ümiro 核心 Secret，以及其他仍安裝外掛宣告的共用 Secret，都會保留。

### 可選的 intent analyzer

官方的 `intent-analyzer` 外掛可以在每個有文字的 turn 做一次 advisory 判斷：是否回覆，以及哪些已註冊工具對模型可見。Discord 的 hard ignore 會先決定，因此不會呼叫 analyzer。若判斷不回覆，訊息只會以 observe 記錄，不會建立 Run、顯示 typing、匯入附件或呼叫模型；失敗與逾時會回到一般 trigger policy。工具可見性只限制模型看到的子集合，Core 仍負責授權與執行，隱藏或幻覺出的工具也會由 runtime 拒絕。

外掛必須透過 WebUI 或 CLI 設定後才會啟用分析，未設定時可安全安裝且保持 inert。它支援 OpenAI Chat Completions 與 Jev TypeSafe backend；只會送出本輪文字與模型可見工具定義，不會送歷史、記憶、Secret、工具結果或 runtime 授權。Jev 使用 `POST https://api.typesafe.ai/v1/systemone` 與可選的 `TYPESAFE_API_KEY` Secret。設定細節請見外掛 repository。

## CLI

```text
umo install | upgrade | rollback | uninstall [--purge]
umo start | stop | restart | status
umo configure --from-env <file>
umo discord configure | status
umo embedding configure | disable | status
umo web status | token
umo backup | restore
umo plugin install | list | enable | disable | update | remove | configure
```

## 架構

```text
apps/cli                  安裝與生命週期 CLI
apps/gateway              daemon：組合根、Discord ingress、控制台
packages/core             領域契約與執行 runtime（無 I/O）
packages/adapter-discord  Discord 傳輸層
packages/model-openai     OpenAI 相容模型 adapter
packages/storage-sqlite   持久化狀態、搜尋與向量 projection
plugins/*                 內掛
templates/workspace       首次執行的 workspace 檔案
```

`@umiro/core` 不知道 Discord、SQLite 或任何外掛的存在。gateway 把 adapter、storage、模型供應者與已啟用的外掛組合起來。adapter 與組合根是系統層，不是外掛。

## 開發

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 從前一代遷移

前一代 ümiro（[umiro-agent-v1](https://github.com/iiimabbie/umiro-agent-v1)）以 JSON 檔存 session，已停止維護。沒有自動遷移：在自己的 `UMIRO_HOME` 下並行安裝本版，把 `SOUL.md`、`OWNER.md` 與要保留的 skills 複製到新 workspace，舊的記憶內容拆進五份 `memory/*.md`。確認沒問題後再把 Discord token 切過來。
