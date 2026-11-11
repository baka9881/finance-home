import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export type SiteContext = { site: { url: string } };

export const WORKER_BUDGET_MS = 8 * 60_000;
const HEALTH_TIMEOUT_MS = 90_000;
const SYNC_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS_PER_STAGE = 6;
const DIAGNOSTIC_HEADERS = [
  "server", "retry-after", "cf-ray", "x-request-id", "x-render-request-id", "x-nf-request-id",
] as const;

type Runtime = {
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  info: (event: string, details?: unknown) => void;
  error: (event: string, details?: unknown) => void;
};

function runtimeWith(overrides: Partial<Runtime>): Runtime {
  return {
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    random: () => Math.random(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    info: (event, details) => console.info(event, details),
    error: (event, details) => console.error(event, details),
    ...overrides,
  };
}

function secureOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Runtime URLs come from Netlify's context or the protected environment,
    // never from the inbound Request URL, body, Host or forwarded headers.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function authenticatedWorkerRequest(request: Request, expectedToken: string | undefined): boolean {
  if (request.method !== "POST" || !expectedToken) return false;
  const suppliedToken = request.headers.get("X-Automation-Token")?.trim() ?? "";
  // Hashes always have the same length, including for missing/wrong tokens.
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function scheduledRequestId(payload: unknown): string {
  if (payload && typeof payload === "object" && "next_run" in payload) {
    const nextRun = (payload as Record<string, unknown>).next_run;
    if (typeof nextRun === "string" && Number.isFinite(Date.parse(nextRun))) {
      // Netlify retries the same scheduled invocation with the same next_run.
      return `netlify-hourly:${new Date(nextRun).toISOString()}`;
    }
  }
  return `netlify-manual:${randomUUID()}`;
}

function safeHeaders(headers: Headers, token: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of DIAGNOSTIC_HEADERS) {
    const value = headers.get(key);
    if (value) result[key] = value.split(token).join("[redacted]").replace(/[\r\n]/g, " ").slice(0, 160);
  }
  return result;
}

class RequestDeadline extends Error {}

async function boundedRequest<T>(
  runtime: Runtime,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestDeadline());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      runtime.fetch(url, { ...init, redirect: "error", signal: controller.signal }).then(consume),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchSyncWorker(
  context: SiteContext,
  suppliedToken: string | undefined,
  requestId: string,
  overrides: Partial<Runtime> = {},
): Promise<void> {
  const runtime = runtimeWith(overrides);
  const origin = secureOrigin(context?.site?.url);
  const token = suppliedToken?.trim();
  if (!origin || !token || !validRequestId(requestId)) throw new Error("finance_sync_dispatch_configuration_invalid");

  try {
    const status = await boundedRequest(runtime, `${origin}/.netlify/functions/finance-sync-worker`, {
      method: "POST", headers: { "X-Automation-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    }, 15_000, async (response) => {
      const status = response.status;
      await response.body?.cancel();
      return status;
    });
    if (status !== 202) throw new Error(`finance_sync_dispatch_http_${status}`);
    // This acknowledges worker dispatch only, not backend acceptance or
    // completed Gmail/Binance updates.
    runtime.info("finance_sync_worker_dispatched");
  } catch (error) {
    // Do not include a network exception, URL, request or response body: they
    // can contain credentials or financial information.
    const code = error instanceof Error && /^finance_sync_dispatch_http_\d{3}$/.test(error.message)
      ? error.message : "finance_sync_dispatch_unavailable";
    runtime.error(code);
    throw new Error(code);
  }
}

type Stage = "health" | "sync";
type Attempt = {
  kind: "ready" | "scheduled" | "already_running" | "already_accepted" | "retry" | "failed";
  reason?: string;
  status?: number;
  headers?: Record<string, string>;
  retryAfter?: string | null;
};

async function attemptRequest(
  stage: Stage,
  origin: string,
  token: string,
  requestId: string,
  timeoutMs: number,
  runtime: Runtime,
): Promise<Attempt> {
  try {
    return await boundedRequest(runtime, `${origin}/api/${stage === "health" ? "health" : "automation/sync"}`, {
      method: stage === "health" ? "GET" : "POST",
      ...(stage === "sync" ? { headers: { "X-Automation-Token": token, "X-Automation-Request-ID": requestId } } : {}),
    }, timeoutMs, async (response): Promise<Attempt> => {
      const metadata = { status: response.status, headers: safeHeaders(response.headers, token) };
      if (!response.ok) {
        await response.body?.cancel();
        return {
          ...metadata,
          kind: [429, 502, 503, 504].includes(response.status) ? "retry" : "failed",
          reason: "http_error", retryAfter: response.headers.get("retry-after"),
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ...metadata, kind: "failed", reason: "invalid_response" };
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ...metadata, kind: "failed", reason: "invalid_response" };
      }
      const data = payload as Record<string, unknown>;
      if (stage === "health" && data.status === "ok") return { kind: "ready" };
      if (stage === "sync" && data.accepted === true && data.status === "scheduled") return { kind: "scheduled" };
      if (stage === "sync" && data.accepted === false && data.status === "already_running") return { kind: "already_running" };
      if (stage === "sync" && data.accepted === false && data.status === "already_accepted") return { kind: "already_accepted" };
      return { ...metadata, kind: "failed", reason: "invalid_response" };
    });
  } catch (error) {
    const timeout = error instanceof RequestDeadline || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
    const retryable = timeout || error instanceof TypeError;
    return { kind: retryable ? "retry" : "failed", reason: timeout ? "request_timeout" : "network_error" };
  }
}

function retryAfterMilliseconds(value: string | null | undefined, now: number): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export async function runSyncWorker(
  backendUrl: string | undefined,
  token: string,
  requestId: string,
  overrides: Partial<Runtime> = {},
): Promise<boolean> {
  const runtime = runtimeWith(overrides);
  const origin = secureOrigin(backendUrl);
  if (!origin || !token || !validRequestId(requestId)) {
    runtime.error("finance_sync_worker_failed", { reason: "configuration_invalid" });
    return false;
  }

  const deadline = runtime.now() + WORKER_BUDGET_MS;
  for (const stage of ["health", "sync"] as const) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_STAGE; attempt += 1) {
      const remaining = deadline - runtime.now();
      if (remaining <= 0) {
        runtime.error("finance_sync_worker_failed", { stage, reason: "budget_exhausted" });
        return false;
      }
      const outcome = await attemptRequest(stage, origin, token, requestId,
        Math.min(remaining, stage === "health" ? HEALTH_TIMEOUT_MS : SYNC_TIMEOUT_MS), runtime);
      if (outcome.kind === "ready") break;
      if (outcome.kind === "scheduled" || outcome.kind === "already_running" || outcome.kind === "already_accepted") {
        runtime.info("finance_sync_backend_accepted", { status: outcome.kind });
        return true;
      }
      const details = { stage, attempt: attempt + 1, reason: outcome.reason, status: outcome.status, headers: outcome.headers };
      if (outcome.kind === "failed" || attempt === MAX_ATTEMPTS_PER_STAGE - 1) {
        runtime.error("finance_sync_worker_failed", details);
        return false;
      }
      const delay = Math.max(
        Math.min(30_000 * 2 ** attempt, 120_000) + Math.floor(runtime.random() * 5_000),
        retryAfterMilliseconds(outcome.retryAfter, runtime.now()),
      );
      if (delay >= deadline - runtime.now()) {
        runtime.error("finance_sync_worker_failed", { ...details, reason: "retry_exceeds_budget" });
        return false;
      }
      runtime.info("finance_sync_worker_retry", { ...details, delayMs: delay });
      await runtime.sleep(delay);
    }
  }
  return false;
}
