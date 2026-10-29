# luna-skill-curator

把 agent skill 包（`SKILL.md` 與其 `references/*.md`）翻成清楚、自然的英文，並整理成分類目錄。翻譯由生成模型負責，**Luna**（OpenAI Decisions API 的 `gpt-6-luna`）負責審查與整理：

| 工作 | 由誰做 | 怎麼做 |
|---|---|---|
| 翻譯、改善措辭 | 生成模型：預設 `codex exec`（用你的 Codex 登入），或 OpenAI Responses API | 規則：意思不變；指令、警告、數字、命令、路徑、程式碼一律保留；以工程師的寫法重寫含糊或像機器翻譯的句子；`SKILL.md` 的 `description` 改寫成「做什麼＋何時用」 |
| 結構檢查 | 程式（不需模型） | 標題數、程式碼區塊的每一行、網址與連結、行內程式碼都要保留；殘留中文不得超過 1% |
| 是否忠實 | Luna `predicate` | 有沒有漏掉或改動任何指令、警告、數字、命令？ |
| 是否清楚 | Luna `predicate` | 不看原文，工程師能不能照著做？ |
| description 是否好用 | Luna `predicate`（只對 `SKILL.md`） | 是否清楚說出這個技能做什麼、何時該用？ |
| 兩個版本選一個 | Luna `choice` | 第一版沒過關時，帶著問題重譯一次，再由 Luna 挑較好的一版 |
| 分類 | Luna `choice` | 每個技能歸到一個類別（可自訂類別清單） |
| 重疊的技能 | Luna `predicate` | 名稱與說明相近的技能兩兩比對：是否在做同一件事？ |

Luna 只回答型別化的問題（是非、選擇、分數），不會寫文字，所以它是審查者與分類者，不是譯者。

## 需求

- Node.js ≥ 22.15，沒有任何依賴套件。
- `OPENAI_API_KEY`：供 Luna 使用。每個檔案約 1–2 次 Decisions 呼叫，每次約 2k–8k 輸入 tokens（上限約 $0.0002–$0.0008）。
- 生成模型：
  - `--backend codex`（預設）：需要已安裝並登入 Codex CLI（`npm i -g @openai/codex`、`codex login`）。使用你的 Codex 方案額度，不按 token 另外計費。
  - `--backend openai`：用 `OPENAI_API_KEY` 呼叫 Responses API，按 token 計費。

## 使用說明

### 步驟 1：準備

1. 確認 Node.js 版本：`node --version` 須為 v22.15 以上。
2. 設定 Luna 的金鑰（二選一）：
   - 在專案資料夾建立 `.env.local`，寫一行 `OPENAI_API_KEY=sk-...`。這個檔案已列在 `.gitignore`，不會進 git。
   - 或在 PowerShell 設定：`$env:OPENAI_API_KEY = "sk-..."`，只對目前視窗有效。
3. 使用預設的 codex 生成器時，先確認 Codex 已登入：`codex login status` 應顯示已登入。

### 步驟 2：預覽（不連網、不花費）

```powershell
cd E:\luna-skill-curator
node bin/luna-skills.js scan E:\install_skills
```

這一步會列出每個 pack 有多少 Markdown 要翻譯、多少英文 `SKILL.md` 要潤飾、有多少程式或資料檔含中文但不會翻譯，以及總共要送給生成模型的檔案數。

### 步驟 3：小量試跑

```powershell
node bin/luna-skills.js run E:\install_skills --out E:\skills-en --limit 5
```

- 只處理前 5 個檔案，其餘留待下次執行。
- 跑完後打開 `E:\skills-en\REPORT.md`，看分數與「Needs a person」一節；再挑一兩個輸出檔與原檔對照，確認譯文符合需要。
- 要先試單一 pack，可以加上 `--only storage-skills-pack-v1.0`，值為不含 `.zip` 的 pack 名稱。

### 步驟 4：完整執行

```powershell
node bin/luna-skills.js run E:\install_skills --out E:\skills-en --jobs 3 --zip
```

- 畫面上每完成一個檔案就印一行，例如 `[12/465] storage-skills-pack-v1.0/…/SKILL.md accepted (faithful 0.93, clear 0.95, trigger 0.95)`。
- **可以隨時中斷**（Ctrl+C）。之後執行同一行指令，已完成的檔案會從 `.cache/` 直接沿用，不會重譯也不會重複付費。
- `--jobs` 是同時翻譯的檔案數。codex 生成器建議 2–4；太高可能碰到方案的速率限制。

### 步驟 5：檢查結果

1. **`REPORT.md`**：
   - Summary：accepted、needs-review、failed 各有幾個檔案。
   - Needs a person：每個未通過的檔案、它的分數與原因（結構問題、Luna 判定的分數、長檔只審了一部分、生成錯誤）。這些檔案請人工對照原文修改。
   - Overlapping skills：Luna 認為在做同一件事的技能，可以考慮合併或改寫 description 讓兩者分得開。
   - Left in Chinese：含中文但沒有翻譯的程式與資料檔。
2. **`CATALOG.md`**：所有技能依類別排列，附英文說明，可直接當作技能總覽。
3. **輸出的 pack**：`E:\skills-en\<pack>\` 與 `<pack>-en.zip`（有加 `--zip` 時），可以直接拿來取代原本的 pack 安裝。

### 步驟 6：處理沒通過的檔案

- `needs-review` 的輸出已經採用 Luna 挑出的較好版本，人工修正後即可使用。
- `failed` 的檔案輸出仍是原文，通常是生成器逾時或錯誤；再執行一次同一行指令就會重試這些檔案（失敗的結果不會寫入快取）。
- 想讓某些檔案完全重譯，刪除 `E:\skills-en\.cache\` 後再執行。修改提示詞後（`PROMPT_VERSION` 改變）快取會自動失效。

### 其他用法

```powershell
# 用 OpenAI API 生成（按 token 計費），並指定模型
node bin/luna-skills.js run E:\install_skills --out E:\skills-en --backend openai --model gpt-6.1-terra

# 只翻有中文的檔案，不潤飾已是英文的 SKILL.md
node bin/luna-skills.js run E:\install_skills --out E:\skills-en --no-polish

# 自訂分類（JSON 陣列：[{"value":"games","description":"game design and development"}, ...]）
node bin/luna-skills.js run E:\install_skills --out E:\skills-en --categories my-categories.json

# 只重寫報告（例如手動修改 report.json 之後）
node bin/luna-skills.js report --out E:\skills-en
```

來源可以是單一 pack 的 `.zip`、解壓後的資料夾，或放滿 `.zip` 的資料夾（每個 zip 都是一個 pack）。原始檔案只讀取，不會被修改。輸出時 `<out>\<pack>\` 資料夾會整個重寫，所以請不要把 `--out` 指到原始檔案所在的位置。

### 常見問題

| 狀況 | 原因與處理 |
|---|---|
| `set OPENAI_API_KEY (Luna reviews every translation)` | 沒有設定金鑰，見步驟 1 |
| `codex exited with code …` | Codex 未登入或額度用完：執行 `codex login`，或稍後再跑 |
| `Luna HTTP 401` | 金鑰無效或沒有 Decisions API 權限 |
| 很多檔案 `needs-review`，原因是「still contains Chinese」 | 原文中專有名詞較多，譯文保留了中文；檢查後可接受，或在提示詞中說明處理方式 |
| 執行很慢 | 每個檔案約 15–60 秒（codex）。可提高 `--jobs`，或先用 `--only` 分批處理 |

## 輸出（`--out`）

| 路徑 | 內容 |
|---|---|
| `<pack>/…` | 英文版的 pack：翻好的 Markdown 取代原檔；其他檔案（程式、資料、二進位）原樣複製；`SKILL.md` 的 `name` 保持不變，`locale` 改為 `en` |
| `<pack>-en.zip` | 加 `--zip` 時，同內容的 zip |
| `REPORT.md` | 每個 pack 的統計、Luna 的平均分數、**需要人工看的檔案**（含原因）、重疊的技能、仍含中文的非 Markdown 檔 |
| `CATALOG.md` | 所有技能依 Luna 的分類列出，附英文說明 |
| `report.json` | 上述所有資料，含每個檔案的分數 |
| `.cache/` | 每個檔案的結果（以來源內容與提示詞版本為鍵），讓重跑時不必重做 |

## 判定規則

- Markdown 檔中文字元佔比超過 0.5% 就翻譯；英文的 `SKILL.md` 也會改善措辭（`--no-polish` 可關閉）；其他 Markdown 原樣複製。
- 通過條件：結構檢查無問題，且 Luna 判定 faithful ≥ 0.8、clear ≥ 0.7（`SKILL.md` 另需 trigger ≥ 0.7）。
- 沒通過時，把結構問題與 Luna 的判定寫進回饋，重譯一次，再由 Luna 選出較好的版本。仍未通過的標為 `needs-review`，輸出仍採用較好的那一版。
- 生成失敗兩次的檔案標為 `failed`，輸出保留原文。
- 長檔案（預設超過 6,000 字元）依標題分段翻譯，不會切在程式碼區塊中間；Luna 審查時每邊最多看 24,000 字元，超過的在報告中註明「只審了一部分」。
- 程式碼、設定與資料檔不翻譯，只列在報告中。

## 開發

```powershell
node --test
```

| 檔案 | 內容 |
|---|---|
| `src/packs.js` | 讀取 zip 或資料夾、寫出資料夾、打包 zip（無依賴的 zip 讀寫） |
| `src/markdown.js` | front matter、分段、中文比例、結構比較 |
| `src/generate.js` | 翻譯提示詞與生成後端（codex、openai、mock） |
| `src/luna.js` | Decisions API：審查、二選一、重疊判定；重試與成本統計 |
| `src/pipeline.js` | 整個流程：規劃、翻譯與審查、重試、快取、分類、重疊、輸出 |
| `src/report.js` | `REPORT.md` 與 `CATALOG.md` |
| `bin/luna-skills.js` | 指令列 |
