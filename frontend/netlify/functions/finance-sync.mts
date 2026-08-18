export default async () => {
  const backendUrl = Netlify.env.get("FINANCE_AUTOMATION_URL")?.replace(/\/$/, "");
  const automationToken = Netlify.env.get("FINANCE_AUTOMATION_TOKEN");

  if (!backendUrl || !automationToken) {
    throw new Error(
      "FINANCE_AUTOMATION_URL 與 FINANCE_AUTOMATION_TOKEN 必須在 Netlify 環境變數中設定。",
    );
  }

  const response = await fetch(`${backendUrl}/api/automation/sync`, {
    method: "POST",
    headers: {
      "X-Automation-Token": automationToken,
    },
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`財務居自動更新啟動失敗（HTTP ${response.status}）：${message}`);
  }

  const result = await response.json();
  console.log("財務居自動更新已交給後端處理：", result);
};

export const config = {
  schedule: "7 * * * *",
};
