// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import scheduledHandler, { config as scheduledConfig } from "../functions/finance-sync.mts";
import workerHandler, { config as workerConfig } from "../functions/finance-sync-worker.mts";
import {
  authenticatedWorkerRequest, dispatchSyncWorker, runSyncWorker,
  scheduledRequestId, validRequestId, WORKER_BUDGET_MS,
} from "../lib/sync-runtime.mts";

const siteUrl = "https://finance-example.netlify.app";
const backendUrl = "https://finance-api.example.com";
const token = "test-only-secret-never-log";
const requestId = "netlify-hourly:2026-10-08T09:07:00.000Z";
const fetchMock = vi.fn<typeof fetch>();
const okHealth = () => Response.json({ status: "ok", mode: "cloud" });
const accepted = () => Response.json({ accepted: true, status: "scheduled" }, { status: 202 });
const workerRequest = (suppliedToken: string = token, method = "POST") => new Request(`${siteUrl}/.netlify/functions/finance-sync-worker`, {
  method,
  headers: { "X-Automation-Token": suppliedToken },
  ...(method === "POST" ? { body: JSON.stringify({ request_id: requestId }) } : {}),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T08:07:00Z"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Netlify", { env: { get: (name: string) => ({
    FINANCE_AUTOMATION_TOKEN: token, FINANCE_AUTOMATION_URL: backendUrl,
  })[name] } });
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scheduled dispatcher", () => {
  it("keeps the hourly schedule and moves long work to a background function", () => {
    expect(scheduledConfig.schedule).toBe("7 * * * *");
    expect(workerConfig.background).toBe(true);
  });

  it("dispatches only to the platform site URL, independent of inbound URL or headers", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    const inbound = new Request("https://untrusted.example/attack", {
      method: "POST", headers: { host: "untrusted.example", "x-forwarded-host": "untrusted.example" },
      body: JSON.stringify({ next_run: "2026-10-08T09:07:00Z", url: "https://untrusted.example" }),
    });
    await scheduledHandler(inbound, { site: { url: siteUrl } });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${siteUrl}/.netlify/functions/finance-sync-worker`, expect.objectContaining({
      method: "POST", redirect: "error", body: JSON.stringify({ request_id: requestId }),
      headers: { "X-Automation-Token": token, "Content-Type": "application/json" },
    }));
    expect(console.info).toHaveBeenCalledWith("finance_sync_worker_dispatched", undefined);
  });

  it("generates stable scheduled IDs and unique manual IDs", () => {
    expect(scheduledRequestId({ next_run: "2026-10-08T09:07:00Z" })).toBe(requestId);
    expect(scheduledRequestId({ next_run: "2026-10-08T17:07:00+08:00" })).toBe(requestId);
    const manual = scheduledRequestId(null);
    expect(manual).toMatch(/^netlify-manual:/);
    expect(validRequestId(manual)).toBe(true);
    expect(scheduledRequestId(null)).not.toBe(manual);
  });

  it.each(["http://finance-example.netlify.app", "https://u:p@finance-example.netlify.app", `${siteUrl}/other`, `${siteUrl}?url=evil`])(
    "does not dispatch to an invalid configured site URL %s", async (url) => {
      await expect(dispatchSyncWorker({ site: { url } }, token, requestId)).rejects.toThrow("configuration_invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("limits dispatch to 15 seconds and suppresses raw network exceptions", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = dispatchSyncWorker({ site: { url: siteUrl } }, token, requestId);
    const rejection = expect(pending).rejects.toThrow("finance_sync_dispatch_unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("does not label a non-202 response as dispatched or log its body", async () => {
    fetchMock.mockResolvedValue(new Response(token, { status: 403 }));
    await expect(dispatchSyncWorker({ site: { url: siteUrl } }, token, requestId)).rejects.toThrow("finance_sync_dispatch_http_403");
    expect(console.info).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(token);
  });
});

describe("authenticated worker", () => {
  it.each(["", "wrong-token", `${token}x`])("makes no external request for an unauthorized invocation", async (supplied) => {
    const response = await workerHandler(workerRequest(supplied));
    expect(response?.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch for a GET or missing runtime secret", async () => {
    expect(authenticatedWorkerRequest(workerRequest(token, "GET"), token)).toBe(false);
    expect(authenticatedWorkerRequest(workerRequest(), undefined)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "has spaces", "has/slashes", "a".repeat(129)])("rejects malformed request IDs before fetching", async (id) => {
    const request = new Request(siteUrl, { method: "POST", headers: { "X-Automation-Token": token }, body: JSON.stringify({ request_id: id }) });
    expect((await workerHandler(request))?.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for a slow health response before starting synchronization", async () => {
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(okHealth()), 80_000)))
      .mockResolvedValueOnce(accepted());
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(79_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${backendUrl}/api/health`, expect.objectContaining({ method: "GET", redirect: "error" }));
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${backendUrl}/api/automation/sync`, expect.objectContaining({
      method: "POST", headers: { "X-Automation-Token": token, "X-Automation-Request-ID": requestId },
    }));
    expect(console.info).toHaveBeenCalledWith("finance_sync_backend_accepted", { status: "scheduled" });
  });

  it("runs the complete authenticated handler with a validated request body", async () => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(accepted());
    await workerHandler(workerRequest());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({
      "X-Automation-Token": token, "X-Automation-Request-ID": requestId,
    });
  });

  it("reuses the ID after a lost POST response and accepts the backend duplicate acknowledgement", async () => {
    fetchMock.mockResolvedValueOnce(okHealth())
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(Response.json({ accepted: false, status: "already_accepted" }, { status: 202 }));
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1]?.signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(fetchMock.mock.calls[2][1]?.headers);
    expect(console.info).toHaveBeenCalledWith("finance_sync_backend_accepted", { status: "already_accepted" });
  });

  it.each(["already_running", "already_accepted"])("recognizes %s as accepted, without reporting completed data", async (status) => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(Response.json({ accepted: false, status }, { status: 202 }));
    expect(await runSyncWorker(backendUrl, token, requestId)).toBe(true);
    expect(console.info).toHaveBeenCalledWith("finance_sync_backend_accepted", { status });
  });

  it.each([401, 403, 400, 404, 500])("does not retry HTTP %s", async (status) => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(new Response(token, { status }));
    expect(await runSyncWorker(backendUrl, token, requestId)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.info).not.toHaveBeenCalledWith("finance_sync_backend_accepted", expect.anything());
  });

  it.each([
    { accepted: true, status: "already_running" }, { accepted: false, status: "scheduled" },
    { accepted: true }, null, [true],
  ])("rejects an unexpected 2xx acceptance payload", async (payload) => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(Response.json(payload, { status: 202 }));
    expect(await runSyncWorker(backendUrl, token, requestId)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("finance_sync_worker_failed", expect.objectContaining({ reason: "invalid_response" }));
  });

  it("rejects non-JSON 2xx and never logs the raw response", async () => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(new Response(token, { status: 202 }));
    expect(await runSyncWorker(backendUrl, token, requestId)).toBe(false);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(token);
  });

  it("backs off for at least 30 seconds on 429 and retains the same request ID", async () => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(accepted());
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(fetchMock.mock.calls[2][1]?.headers);
  });

  it.each(["100", "Thu, 08 Oct 2026 08:08:40 GMT"])("honors Retry-After %s", async (retryAfter) => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": retryAfter } }))
      .mockResolvedValueOnce(accepted());
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(99_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
  });

  it.each([502, 503, 504])("backs off on temporary HTTP %s", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(okHealth()).mockResolvedValueOnce(accepted());
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(true);
  });

  it("retries temporary network failures without including error messages", async () => {
    fetchMock.mockResolvedValueOnce(okHealth()).mockRejectedValueOnce(new TypeError(`network failure ${token}`)).mockResolvedValueOnce(accepted());
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(true);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(token);
  });

  it("bounds hung health requests and all retries to the eight-minute budget", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET_MS);
    expect(await pending).toBe(false);
    expect(fetchMock.mock.calls.every((call) => call[0] === `${backendUrl}/api/health`)).toBe(true);
    expect(fetchMock.mock.calls.every((call) => (call[1]?.signal as AbortSignal).aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry earlier than a Retry-After beyond the invocation budget", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "900" } }));
    expect(await runSyncWorker(backendUrl, token, requestId)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.error).toHaveBeenCalledWith("finance_sync_worker_failed", expect.objectContaining({ reason: "retry_exceeds_budget" }));
  });

  it("logs only allowlisted headers, redacts reflected secrets, and caps persistent failures", async () => {
    fetchMock.mockImplementation(async () => new Response(token, { status: 429, headers: {
      "server": "cloudflare", "cf-ray": "example-ray", "retry-after": "30", "x-request-id": token,
      "set-cookie": `session=${token}`, "x-automation-token": token,
    } }));
    const pending = runSyncWorker(backendUrl, token, requestId);
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET_MS);
    expect(await pending).toBe(false);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(vi.getTimerCount()).toBe(0);
    const logs = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("set-cookie");
    expect(logs).toContain("example-ray");
    expect(logs).toContain("[redacted]");
  });
});
