export interface AutomationStatus {
  enabled: boolean;
  schedule: "hourly";
  running: boolean;
  connected_exchanges: number;
  email_connected: boolean;
  last_status: "idle" | "running" | "success" | "warning" | "failed";
  last_started_at?: string;
  last_run_at?: string;
  last_error?: string;
  last_result?: {
    exchanges_updated: number;
    exchanges_skipped: number;
    market_updated: number;
    market_skipped: number;
    fx_saved: number;
    warnings: string[];
    errors: string[];
  };
}

const SYNC_DELAY_MS = 2 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export function automationTimestamp(value?: string) {
  if (!value) return null;
  const timestamp = Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function describeAutomationStatus(
  status: AutomationStatus | undefined,
  now = Date.now(),
  unavailable = false,
) {
  const result = (
    label: string,
    tone: "green" | "amber" | "slate",
    description: string,
    needsAttention = false,
  ) => ({ label, tone, description, needsAttention });

  if (unavailable) return result("無法確認同步", "amber", "目前無法確認背景同步，請重新載入設定。", true);
  if (!status) return result("確認同步狀態…", "slate", "正在確認背景同步狀態。");
  if (!status.enabled) return result("手動同步", "slate", "請按「立即同步」更新資料。");

  const startedAt = automationTimestamp(status.last_started_at);
  const completedAt = automationTimestamp(status.last_run_at);
  const recent = (timestamp: number | null) => timestamp !== null
    && now - timestamp <= SYNC_DELAY_MS
    && timestamp - now <= CLOCK_TOLERANCE_MS;

  if (status.running) {
    return recent(startedAt)
      ? result("正在同步", "green", "正在更新資料。")
      : result("同步延遲", "amber", "同步尚未完成，可稍後重新檢查。", true);
  }
  // A persisted running flag without the backend lock means a previous job stopped.
  if (status.last_status === "running") return result("同步延遲", "amber", "上次同步未完成，可先按「立即同步」。", true);
  if (!status.last_run_at) return result("尚未同步", "amber", "背景同步已設定，尚無完成記錄。", true);
  if (completedAt === null || completedAt - now > CLOCK_TOLERANCE_MS) {
    return result("無法確認同步", "amber", "同步時間無法確認，請重新載入設定。", true);
  }
  if (!recent(completedAt)) return result("同步延遲", "amber", "背景同步已延遲，可先按「立即同步」。", true);
  if (status.last_status === "failed") return result("同步失敗", "amber", "上次同步失敗，可先按「立即同步」。", true);
  if (status.last_status === "warning") return result("部分同步失敗", "amber", "部分資料尚未更新，可先按「立即同步」。", true);
  if (status.last_status !== "success") return result("尚未同步", "amber", "背景同步已設定，尚無完成記錄。", true);
  return result("每小時更新", "green", "背景同步已啟用，每小時更新。");
}
