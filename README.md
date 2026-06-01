# HK Bus BBI Telegram Bot (香港巴士轉乘優惠查詢機器人)

本專案是一個基於 **Google Apps Script (GAS)** 與 **Google Sheets** 的無伺服器 (Serverless) 香港巴士轉乘優惠 (BBI) 查詢 Telegram 機器人。

採用了 **九巴快取 + 城巴即時查詢** 的混合式架構，完美解決了傳統爬蟲在 Google Apps Script 上因超時或 IP 被阻擋的問題，並提供互動式的 **Inline Keyboard** 方向選擇選單，提供流暢的用戶體驗。

---

## 🚀 專案特點

1. **混合式架構 (Hybrid Architecture)**：
   - **九巴 (KMB) 轉乘**：每週自動從九巴官方 API 下載數據並寫入 Google 試算表快取（採用記憶體預先分組壓縮演算法，保證單個儲存格不超過試算表 50,000 字元限制）。
   - **城巴 (CTB) 轉乘**：在用戶查詢時，**即時**向城巴 concession API 請求最新數據，保證 100% 準確且免維護。
2. **Inline Keyboard 互動選單**：
   - 用戶輸入路線後，機器人會列出該路線所有可用的公司與方向按鈕。
   - 用戶點擊方向按鈕後，機器人會自動更新按鈕狀態並僅發送該方向的轉乘優惠資訊，避免一次性發送過長訊息。
3. **無伺服器 (Serverless) 部署**：
   - 完全運行於 Google Apps Script，無需購買任何主機或 VPS。
4. **HTML 格式化與安全逸出**：
   - 使用 HTML parse mode 取代不穩定的 Markdown 語法，搭配 `escapeHtml` 逸出機制，防止因為轉乘備註中的特殊字元（如 `*`、`_` 等）導致 Telegram 拒收訊息。
5. **長訊息自動分頁**：
   - 對於轉乘選項極多的繁忙路線（如 `970`、`A11`），自動按巴士站將訊息分割成多條發送，防範 Telegram 4,096 字元長度限制。

---

## 📂 檔案結構

- `bbi_bot.js` : 部署於 Google Apps Script 的生產環境程式碼（含 Webhook 處理、KMB 快取更新、城巴即時查詢與 Telegram API 發送）。
- `local_test.py` : 本地 Python 測試工具，可模擬抓取與在終端機進行路線轉乘查詢。
- `test_query_oneoff.py` : 本地單次批次測試查詢腳本。

---

## 🛠️ 生產環境部署教學

### 步驟 1：建立 Google 試算表與開啟 Apps Script
1. 前往 [Google 試算表](https://sheets.google.com) 建立一個全新的空白試算表。
2. 點選上方選單的 **擴充功能 (Extensions)** -> **Apps Script**。
3. 清除編輯器內所有預設程式碼，複製本專案中的 `bbi_bot.js` 完整內容並貼上。
4. 將專案命名為 `HK Bus BBI Bot` 並儲存。

### 步驟 2：設定 Telegram 機器人
1. 在 Telegram 中搜尋官方帳號 `@BotFather`。
2. 發送 `/newbot`，按照指示設定機器人名稱，並取得 **API Token**（格式如 `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`）。
3. 回到 Google Apps Script 編輯器，點選左側選單的 **專案設定 (Project Settings)**（齒輪圖示）。
4. 滾動至下方 **指令碼屬性 (Script Properties)**，新增一個屬性：
   - 屬性名稱 (Property)：`TELEGRAM_BOT_TOKEN`
   - 屬性值 (Value)：*貼上剛才取得的 Telegram API Token*
5. 點選 **儲存指令碼屬性**。

### 步驟 3：初始化九巴快取數據
1. 回到 Apps Script 程式碼編輯器。
2. 在上方工具列的函數下拉選單中選取 `refreshBbiData`。
3. 點選 **執行 (Run)**。
4. 首次執行需要授權：點選「審查權限 (Review permissions)」-> 選擇您的 Google 帳戶 -> 點選「進階 (Advanced)」-> 點選「前往 Untitled project (不安全)」-> 點選「允許 (Allow)」。
5. 執行完成後，回到您的 Google 試算表，會看到名為 `BBI_Cache` 的分頁已被建立，裡面包含約 1500 列的九巴轉乘快取數據。

### 步驟 4：部署為網頁應用程式
1. 在 Apps Script 頁面右上方點選 **部署 (Deploy)** -> **新增部署 (New deployment)**。
2. 點選左上角設定圖示選取類型為 **網頁應用程式 (Web app)**。
3. 填寫說明（例如：`v1.0`）。
4. **執行身分 (Execute as)** 選擇：**我 (您的帳號)**。
5. **誰有權限存取 (Who has access)** 選擇：**任何人 (Anyone)**。
6. 點選 **部署 (Deploy)**，並複製產生的 **網頁應用程式 URL**（通常以 `/exec` 結尾）。

### 步驟 5：註冊 Telegram Webhook
1. 回到 Apps Script 編輯器。
2. 找到最下方的 `setTelegramWebhook` 函數。
3. 在 `var webAppUrl = "";` 雙引號內，貼上您在步驟 4 複製的**網頁應用程式 URL**：
   ```javascript
   var webAppUrl = "https://script.google.com/macros/s/XXXXX/exec";
   ```
4. 在上方下拉選單選擇 `setTelegramWebhook` 函數並點選 **執行**。
5. 查看下方日誌，若顯示 `Webhook 註冊結果: {"ok":true,"result":true,"description":"Webhook was set"}` 即可完成註冊。

### 步驟 6：設定每週自動更新排程 (Cron Trigger)
為了保持九巴數據的專案準確性，建議設定 GAS 定期在背景更新快取：
1. 點選 Apps Script 左側選單的 **觸發程序 (Triggers)**（時鐘圖示）。
2. 點選右下角的 **新增觸發程序 (Add Trigger)**。
   - 選擇要執行的函數：`refreshBbiData`
   - 選擇要執行的部署來源：`Head`
   - 選擇活動來源：`時間驅動 (Time-driven)`
   - 選擇時間型觸發程序類型：`每週定時器 (Week timer)`
   - 選擇星期幾：*選擇您偏好的日子（例如：每週日）*
   - 選擇時段：*低流量時段（例如：凌晨 2 點至 3 點）*
3. 點選 **儲存**。

現在，您就可以在 Telegram 上向您的機器人發送任何路線號碼（如 `970`、`968`、`A11`）來獲取轉乘優惠資訊了！

---

## 🐍 本地測試 (Python)

如果您想在本地離線調試爬蟲與轉乘邏輯：
1. 確保本地安裝了 Python 3。
2. 在本機專案目錄下執行：
   ```bash
   python local_test.py
   ```
3. 程式會先載入九巴快取，隨後進入互動式查詢。輸入路線號碼即可查看格式化輸出。

---

## 📝 授權條款

本專案採用 MIT 授權條款發布。
