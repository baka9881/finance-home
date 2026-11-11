// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AutomationStatus } from "../automationStatus";
import SettingsPage from "./SettingsPage";

vi.mock("../api", () => ({ api: vi.fn(), apiBlob: vi.fn() }));

const status: AutomationStatus = {
  enabled: true,
  schedule: "hourly",
  running: false,
  connected_exchanges: 1,
  email_connected: true,
  last_status: "success",
  last_started_at: "2026-10-07T00:07:00",
  last_run_at: "2026-10-07T00:10:19",
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T08:38:00Z"));
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/automation/status") return status;
    if (path === "/exchanges/binance") return [{ account_id: 1, account_name: "幣安", owner: "me", owner_label: "我", connected: true }];
    if (path === "/email/gmail/status") return { configured: true, connected: true, email: "owner@example.com", active_rules: 1, pending_bills: 0, last_sync_at: "2026-10-07T00:10:19" };
    return [];
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function show(cachedStatus?: AutomationStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedStatus) client.setQueryData(["automation-status"], cachedStatus);
  render(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
}

it("shows delayed synchronization in both connected services and preserves the previous completion time", async () => {
  show();
  expect((await screen.findAllByText("同步延遲")).length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("自動更新中")).toBeNull();
  expect(screen.queryByText("每小時同步")).toBeNull();
  expect(screen.getByText("最近完成")).toBeTruthy();
  expect(screen.getAllByText(/2026\/10\/7/).length).toBeGreaterThan(0);
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});

it("replaces a cached green synchronization badge when the current status check fails", async () => {
  const defaultApi = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/automation/status") throw new Error("網路失敗");
    return defaultApi(path, options);
  });
  show({ ...status, last_started_at: "2026-10-08T08:07:00", last_run_at: "2026-10-08T08:10:00" });
  expect((await screen.findAllByText("無法確認同步")).length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("每小時更新")).toBeNull();
  expect(screen.queryByText("自動更新中")).toBeNull();
});
