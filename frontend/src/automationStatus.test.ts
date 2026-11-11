import { expect, it } from "vitest";
import { describeAutomationStatus, type AutomationStatus } from "./automationStatus";

const now = Date.parse("2026-10-08T08:38:00Z");
const status: AutomationStatus = {
  enabled: true,
  schedule: "hourly",
  running: false,
  connected_exchanges: 1,
  email_connected: true,
  last_status: "success",
  last_started_at: "2026-10-08T08:07:00",
  last_run_at: "2026-10-08T08:10:00",
};

it("only describes the hourly schedule as healthy after a recent successful completion", () => {
  expect(describeAutomationStatus(status, now)).toMatchObject({ label: "每小時更新", tone: "green", needsAttention: false });
  expect(describeAutomationStatus({ ...status, last_run_at: undefined }, now)).toMatchObject({ label: "尚未同步", tone: "amber" });
});

it("flags the scheduler as delayed after two missed hourly updates even if the last result succeeded", () => {
  expect(describeAutomationStatus({ ...status, last_run_at: "2026-10-07T00:10:19" }, now))
    .toMatchObject({ label: "同步延遲", tone: "amber", needsAttention: true });
  expect(describeAutomationStatus(status, Date.parse("2026-10-08T10:10:01Z")).label).toBe("同步延遲");
});

it("supports timezone offsets without falsely marking a recent completion as delayed", () => {
  expect(describeAutomationStatus({ ...status, last_run_at: "2026-10-08T16:10:00+08:00" }, now).label).toBe("每小時更新");
});

it("distinguishes current work from a stale or interrupted running state", () => {
  expect(describeAutomationStatus({ ...status, running: true, last_status: "running" }, now).label).toBe("正在同步");
  expect(describeAutomationStatus({ ...status, running: true, last_started_at: "2026-10-07T00:07:00" }, now).label).toBe("同步延遲");
  expect(describeAutomationStatus({ ...status, last_status: "running" }, now).label).toBe("同步延遲");
});

it("does not treat recent failed or partial completions as successful synchronization", () => {
  expect(describeAutomationStatus({ ...status, last_status: "failed" }, now)).toMatchObject({ label: "同步失敗", tone: "amber" });
  expect(describeAutomationStatus({ ...status, last_status: "warning" }, now)).toMatchObject({ label: "部分同步失敗", tone: "amber" });
});

it("does not claim cached healthy state is current when checking the status fails", () => {
  expect(describeAutomationStatus(status, now, true)).toMatchObject({ label: "無法確認同步", tone: "amber", needsAttention: true });
});

it("does not claim disabled or unloaded synchronization automatically updates on page open", () => {
  expect(describeAutomationStatus({ ...status, enabled: false }, now)).toMatchObject({ label: "手動同步", tone: "slate" });
  expect(describeAutomationStatus(undefined, now)).toMatchObject({ label: "確認同步狀態…", tone: "slate" });
});

it("does not present malformed or implausibly future completion dates as healthy", () => {
  expect(describeAutomationStatus({ ...status, last_run_at: "invalid" }, now).label).toBe("無法確認同步");
  expect(describeAutomationStatus({ ...status, last_run_at: "2026-10-09T08:10:00" }, now).label).toBe("無法確認同步");
});
