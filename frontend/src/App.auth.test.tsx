// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, type AuthStatus } from "./api";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  CLOUD_AUTH_EXPECTED: true,
  api: vi.fn(),
}));

vi.mock("./pages/DashboardPage", () => ({
  default: () => <div>登入後總覽</div>,
}));

const hostedStatus: AuthStatus = {
  required: true,
  authenticated: false,
  session_expires_at: null,
  data_location: "cloud",
};

function showApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><App /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/health") return { status: "ok" } as never;
    if (path === "/activity") return { revision: "one" } as never;
    return {} as never;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
});

it("shows the login form immediately in a cloud build without a token", () => {
  showApp();

  expect(screen.getByRole("heading", { name: "登入財務居" })).toBeTruthy();
  expect(screen.queryByText("正在確認登入狀態…")).toBeNull();
  expect(vi.mocked(api).mock.calls.some(([path]) => path === "/auth/status")).toBe(false);
});

it.each([
  { name: "login", status: hostedStatus, expected: "登入財務居" },
  { name: "finance pages", status: { ...hostedStatus, authenticated: true }, expected: "登入後總覽" },
])("times out a stalled auth check and retries into $name", async ({ status, expected }) => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/status") {
      checks += 1;
      if (checks === 1) return new Promise<never>(() => {});
      return status as never;
    }
    if (path === "/health") return { status: "ok" } as never;
    if (path === "/activity") return { revision: "one" } as never;
    return {} as never;
  });

  vi.useFakeTimers();
  showApp();
  expect(screen.getByText("正在確認登入狀態…")).toBeTruthy();
  expect(checks).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByRole("heading", { name: "暫時無法確認登入狀態" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新檢查" })).toBeTruthy();

  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "重新檢查" }));
  expect(checks).toBe(2);
  expect(await screen.findByText(expected)).toBeTruthy();
});
