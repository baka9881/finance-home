// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, ApiError, type AuthStatus } from "./api";

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
const authenticatedStatus: AuthStatus = { ...hostedStatus, authenticated: true };

function deferredStatus() {
  let resolve!: (value: AuthStatus) => void;
  const promise = new Promise<AuthStatus>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

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
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(screen.getByRole("heading", { name: "暫時無法確認登入狀態" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新檢查" })).toBeTruthy();

  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "重新檢查" }));
  expect(checks).toBe(2);
  expect(await screen.findByText(expected)).toBeTruthy();
});

it("keeps one slow cloud request alive and enters finance pages when it completes at 50 seconds", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  const response = deferredStatus();
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === "/auth/status") {
      signal = options?.signal as AbortSignal;
      return response.promise as never;
    }
    return Promise.resolve({ revision: "one" }) as never;
  });
  vi.useFakeTimers();
  showApp();

  await advance(10_000);
  expect(screen.getByText("雲端連線較慢，正在繼續確認…")).toBeTruthy();
  expect(signal?.aborted).toBe(false);
  expect(screen.queryByText("登入後總覽")).toBeNull();
  expect(screen.queryByRole("heading", { name: "登入財務居" })).toBeNull();
  await advance(40_000);
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/auth/status")).toHaveLength(1);
  await act(async () => { response.resolve(authenticatedStatus); });
  vi.useRealTimers();
  expect(await screen.findByText("登入後總覽")).toBeTruthy();
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});

it("stops a stalled request at the total deadline, keeps the token, and ignores late success", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  const response = deferredStatus();
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === "/auth/status") {
      signal = options?.signal as AbortSignal;
      return response.promise as never;
    }
    return Promise.resolve({}) as never;
  });
  vi.useFakeTimers();
  showApp();
  await advance(89_999);
  expect(signal?.aborted).toBe(false);
  expect(screen.queryByRole("heading", { name: "暫時無法確認登入狀態" })).toBeNull();
  await advance(1);
  expect(signal?.aborted).toBe(true);
  expect(screen.getByRole("heading", { name: "暫時無法確認登入狀態" })).toBeTruthy();
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
  await act(async () => { response.resolve(authenticatedStatus); });
  expect(screen.queryByText("登入後總覽")).toBeNull();
  expect(screen.getByRole("heading", { name: "暫時無法確認登入狀態" })).toBeTruthy();
});

it.each([
  { name: "network", error: new TypeError("Failed to fetch") },
  { name: "502", error: new ApiError(502, "Bad gateway") },
  { name: "503", error: new ApiError(503, "Server waking") },
  { name: "504", error: new ApiError(504, "Gateway timeout") },
])("automatically recovers from $name failures after two bounded retries", async ({ error }) => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/status") {
      checks += 1;
      if (checks < 3) throw error;
      return authenticatedStatus as never;
    }
    return { revision: "one" } as never;
  });
  vi.useFakeTimers();
  showApp();
  await advance(1_999);
  expect(checks).toBe(1);
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
  await advance(1);
  expect(checks).toBe(2);
  await advance(3_999);
  expect(checks).toBe(2);
  await advance(1);
  expect(checks).toBe(3);
  vi.useRealTimers();
  expect(await screen.findByText("登入後總覽")).toBeTruthy();
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});

it("keeps retrying a platform 503 until the total deadline without treating it as a configuration error", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/status") {
      checks += 1;
      throw new ApiError(503, "Service unavailable");
    }
    return {} as never;
  });
  vi.useFakeTimers();
  showApp();
  await advance(6_000);
  expect(checks).toBe(3);
  expect(screen.queryByRole("heading", { name: "暫時無法確認登入狀態" })).toBeNull();
  await advance(84_000);
  // Retries back off at 2, 4, 8 and then every 15 seconds until the 90 second deadline.
  expect(checks).toBe(9);
  expect(screen.getByRole("heading", { name: "暫時無法確認登入狀態" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "登入保護設定不一致" })).toBeNull();
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});

it("uses the original total deadline when a slow attempt is retried", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  let retrySignal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === "/auth/status") {
      checks += 1;
      if (checks === 1) {
        return new Promise((_resolve, reject) => {
          window.setTimeout(() => reject(new ApiError(502, "Server starting")), 85_000);
        }) as never;
      }
      retrySignal = options?.signal as AbortSignal;
      return new Promise<never>(() => {});
    }
    return Promise.resolve({}) as never;
  });
  vi.useFakeTimers();
  showApp();
  await advance(87_000);
  expect(checks).toBe(2);
  expect(retrySignal?.aborted).toBe(false);
  await advance(3_000);
  expect(retrySignal?.aborted).toBe(true);
  expect(screen.getByRole("heading", { name: "暫時無法確認登入狀態" })).toBeTruthy();
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});

it("requires login and clears the token only after a confirmed 401", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/status") {
      checks += 1;
      throw new ApiError(401, "登入已失效");
    }
    return { status: "ok" } as never;
  });
  showApp();
  expect(await screen.findByRole("heading", { name: "登入財務居" })).toBeTruthy();
  expect(localStorage.getItem("finance:authToken")).toBeNull();
  expect(checks).toBe(1);
  expect(screen.queryByText("登入後總覽")).toBeNull();
});

it("keeps an explicitly unprotected cloud backend blocked", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  vi.mocked(api).mockResolvedValue({ required: false, authenticated: true, data_location: "local" } as never);
  showApp();
  expect(await screen.findByRole("heading", { name: "登入保護設定不一致" })).toBeTruthy();
  expect(screen.queryByText("登入後總覽")).toBeNull();
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});

it("stops checking safely when the status response is malformed", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  vi.mocked(api).mockResolvedValue(null as never);
  vi.useFakeTimers();
  showApp();
  await advance(0);
  // A response without the expected shape is blocked as a configuration problem instead of retried.
  expect(screen.getByRole("heading", { name: "登入保護設定不一致" })).toBeTruthy();
  expect(screen.queryByText("登入後總覽")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});

it("cancels the old auth check and prevents its late response from overriding a newer result", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  const oldResponse = deferredStatus();
  const newResponse = deferredStatus();
  const signals: AbortSignal[] = [];
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === "/auth/status") {
      signals.push(options?.signal as AbortSignal);
      return (signals.length === 1 ? oldResponse.promise : newResponse.promise) as never;
    }
    return Promise.resolve({ revision: "one" }) as never;
  });
  vi.useFakeTimers();
  showApp();
  await advance(5_000);
  act(() => { window.dispatchEvent(new Event("finance:auth-changed")); });
  expect(signals).toHaveLength(2);
  expect(signals[0].aborted).toBe(true);
  await advance(5_000);
  expect(screen.getByText("正在確認登入狀態…")).toBeTruthy();
  expect(screen.queryByText("雲端連線較慢，正在繼續確認…")).toBeNull();
  await act(async () => { newResponse.resolve(authenticatedStatus); });
  await act(async () => { oldResponse.resolve(hostedStatus); });
  vi.useRealTimers();
  expect(await screen.findByText("登入後總覽")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "登入財務居" })).toBeNull();
});

it("clears a scheduled retry when a new auth check starts", async () => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/status") {
      checks += 1;
      if (checks === 1) throw new TypeError("Failed to fetch");
      return new Promise<never>(() => {});
    }
    return {} as never;
  });
  vi.useFakeTimers();
  showApp();
  await advance(1_000);
  act(() => { window.dispatchEvent(new Event("finance:auth-changed")); });
  expect(checks).toBe(2);
  await advance(5_000);
  expect(checks).toBe(2);
});

it.each(["pending request", "scheduled retry"])("cleans up an unmounted check with a $name", async (mode) => {
  localStorage.setItem("finance:authToken", "saved-token");
  let checks = 0;
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/auth/status") {
      checks += 1;
      signal = options?.signal as AbortSignal;
      if (mode === "scheduled retry") throw new TypeError("Failed to fetch");
      return new Promise<never>(() => {});
    }
    return {} as never;
  });
  vi.useFakeTimers();
  const app = showApp();
  await advance(1_000);
  app.unmount();
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await advance(75_000);
  expect(checks).toBe(1);
  expect(localStorage.getItem("finance:authToken")).toBe("saved-token");
});
