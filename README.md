# 財務居

本機單人使用的個人財務分析工具。整合銀行、信用卡、證券、加密貨幣與負債，所有資料預設只保存在這台電腦。

## 第一次安裝

最簡單的方式是雙擊 `setup.cmd`。也可以在 PowerShell 執行：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\setup.ps1
```

完成後雙擊 `run.cmd` 啟動個人資料庫，或執行：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\run.ps1
```

瀏覽器開啟 <http://127.0.0.1:8000>。

如需作品展示，可改用匿名示範資料：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\run-demo.ps1
```

個人與示範模式分別使用 `data/finance.db` 和 `data/demo.db`，不會互相讀取。

## 開發模式

後端：

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload
```

前端另開一個 PowerShell：

```powershell
cd frontend
npm.cmd run dev
```

開發介面位於 <http://127.0.0.1:5173>，`/api` 會自動轉送至 FastAPI。

## 資料來源

- 台灣上市股票：臺灣證券交易所 OpenAPI
- 台灣上櫃股票：證券櫃檯買賣中心 OpenAPI
- 美股：Alpha Vantage 每日收盤價（需免費 API key）
- 加密貨幣：CoinGecko Simple Price
- 匯率：中央銀行統計資料庫

行情與財務健康分數僅供個人管理參考，不構成投資建議。
