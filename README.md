# Finance Home

![Finance Home cover](frontend/public/finance-home-cover.png)

Finance Home is a privacy-first personal finance dashboard designed for single-user use. It brings bank accounts, credit cards, investments, cryptocurrency, and liabilities into one place while keeping data on the local computer by default.

## Highlights

- Unified account, transaction, investment, debt, and cash-flow tracking
- Separate personal and anonymous demo databases
- Market data for Taiwan-listed stocks, U.S. stocks, cryptocurrency, and exchange rates
- Optional scheduled cloud synchronization and daily asset snapshots
- Optional read-only Gmail synchronization for credit-card notifications and statements
- Responsive React interface backed by a FastAPI service

## First-time setup

The easiest option on Windows is to double-click `setup.cmd`. You can also run the setup script from PowerShell:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\setup.ps1
```

When setup is complete, double-click `run.cmd` to start the personal database, or run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\run.ps1
```

Open <http://127.0.0.1:8000> in a browser.

For a portfolio demonstration without personal data, start the application with its anonymous demo dataset:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\run-demo.ps1
```

Personal and demo modes use `data/finance.db` and `data/demo.db`, respectively. The two databases are isolated from each other.

## Development

Start the backend:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload
```

Open a second PowerShell window and start the frontend:

```powershell
cd frontend
npm.cmd run dev
```

The development interface is available at <http://127.0.0.1:5173>. Requests under `/api` are automatically proxied to FastAPI.

## Data sources

- Taiwan-listed stocks: Taiwan Stock Exchange OpenAPI
- Taiwan OTC stocks: Taipei Exchange OpenAPI
- U.S. stocks: Alpha Vantage daily closing prices (a free API key is required)
- Cryptocurrency: CoinGecko Simple Price API
- Exchange rates: Central Bank of the Republic of China statistical database

Market data and the financial health score are provided for personal financial management only and do not constitute investment advice.

## Scheduled cloud updates

The production setup uses a Netlify Scheduled Function to call the Render backend once per hour. This allows connected Binance accounts, available market prices, exchange rates, and daily asset snapshots to be updated even when the website is not open.

Set the same `FINANCE_AUTOMATION_TOKEN` in both Render and Netlify. The following variables are required in Netlify:

```text
FINANCE_AUTOMATION_URL=https://finance-home-api-sg.onrender.com
FINANCE_AUTOMATION_TOKEN=use-a-long-random-secret
```

Secrets must be stored in platform environment variables. Never place them in `netlify.toml` or commit them to Git. The Settings page shows whether scheduling is enabled, when it last ran, and whether an error occurred.

## Gmail credit-card synchronization

The Settings page can connect to Gmail with read-only permission to process credit-card purchase notifications and electronic statements. Only messages matching the sender, subject, and last four card digits configured by the user are processed. Gmail message IDs and transaction fingerprints prevent duplicates. Original messages and attachments are not stored; PDF passwords and Google refresh tokens are encrypted in the backend.

After a payment due date, Finance Home records a transfer from the selected payment account to the credit-card account and updates both balances. It never signs in to online banking or initiates a real bank payment. Automation stops and requests confirmation when the payment account has insufficient funds, the statement uses a different currency, or the credit-card balance appears inconsistent.

### Google Cloud configuration

1. Enable the Gmail API, configure the OAuth consent screen, and add your Gmail account as a test user.
2. Create an OAuth client for a web application.
3. Use `http://127.0.0.1:8000/api/email/gmail/callback` as the local redirect URI. For cloud deployment, use the same path on the Render backend.
4. Configure `FINANCE_GOOGLE_CLIENT_ID`, `FINANCE_GOOGLE_CLIENT_SECRET`, `FINANCE_GOOGLE_REDIRECT_URI`, `FINANCE_FRONTEND_URL`, and a stable `FINANCE_CREDENTIAL_SECRET` in the backend environment.
5. In Finance Home, open **Settings → Credit-card email automation**, connect Gmail, and create a matching rule.

The Gmail `gmail.readonly` scope is restricted. Making the application available to other users may require Google OAuth verification and a security assessment. For personal use, the account can remain an OAuth test user.

## Privacy and security

- Personal databases, environment files, credentials, and generated logs are excluded from Git.
- Gmail access is read-only and user-configured.
- Financial data remains local unless cloud deployment is explicitly configured.
- Anonymous demo mode is the recommended option for presentations and grading.

No open-source license is currently granted. The source code is publicly viewable for portfolio and evaluation purposes; all rights are reserved unless stated otherwise.
