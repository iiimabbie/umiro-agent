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
| **外掛** | 內建與外部外掛共用同一套 manifest 與 runtime；從 GitHub 安裝、啟用、設定、更新、移除 |
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

填入憑證並啟動：

```bash
cp .env.example .env
$EDITOR .env
umo configure --from-env .env
umo start
umo status
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
LLM_BASE_URL=http://localhost:8317/v1
LLM_API_KEY=
LLM_MODEL=
```

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

## 外掛

內建外掛隨 release 出貨，可停用但不可移除：`context-files`、`memory`、`scheduler`、`subagent`、`host-tools`、`discord-tools`。不裝任何外部外掛，ümiro 已是完整的 agent。

外部外掛另行安裝，官方集合在 [umiro-plugins](https://github.com/iiimabbie/umiro-plugins)：

| 外掛 | 功能 |
|---|---|
| `people` | 記錄 agent 遇到的人，出現時附進 prompt |
| `soul-guardian` | 定期檢查 `SOUL.md` 與 `AGENT.md` 是否被改動，一鍵還原 |
| `coder` | 寫程式用的子代理 profile |
| `google` | Gmail、Calendar、Tasks、Drive 工具，OAuth 授權 |
| `tool-activity` | Run 使用工具時，在 Discord 即時顯示她正在做什麼 |
| `daily-report` | 排程的每日摘要 |

```bash
umo plugin install https://github.com/iiimabbie/umiro-plugins.git --workspace people
umo plugin list
umo plugin enable | disable | update | remove <source>
umo plugin configure <source> --config '{"key":"value"}'
```

兩種外掛共用同一套 manifest、權限、生命週期與 runtime。外掛宣告需要的 capability，host 會把它限制在呼叫者本身被允許的範圍內。

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
plugins/*                 內建外掛
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
