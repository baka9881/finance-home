const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const API_BASE = configuredApiUrl ? `${configuredApiUrl}/api` : "/api";
const AUTH_TOKEN_KEY = "finance:authToken";

// This is a deployment assertion, not the source of truth for a live session.
// The backend /auth/status response decides whether access is currently allowed.
export const CLOUD_AUTH_EXPECTED = import.meta.env.VITE_AUTH_REQUIRED === "true";

export type AuthStatus = {
  required: boolean;
  authenticated: boolean;
  session_expires_at: string | null;
  data_location: "local" | "cloud";
};

export type AuthGateState = "authenticated" | "anonymous" | "configuration-error";

export function resolveAuthGate(status: AuthStatus, cloudAuthExpected: boolean): AuthGateState {
  if (cloudAuthExpected && (!status.required || status.data_location !== "cloud")) {
    return "configuration-error";
  }
  if (status.required && !status.authenticated) return "anonymous";
  return "authenticated";
}

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token: string) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  window.dispatchEvent(new Event("finance:auth-changed"));
}

export function clearAuthToken() {
  if (!localStorage.getItem(AUTH_TOKEN_KEY)) return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  window.dispatchEvent(new Event("finance:auth-changed"));
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiResponse(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const token = getAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `操作失敗（${response.status}）`;
    try {
      const payload = await response.json();
      message = typeof payload.detail === "string" ? payload.detail : Array.isArray(payload.detail)
        ? "部分欄位格式不正確，請檢查日期、金額與必填欄位後重試。" : message;
    } catch {
      // Keep the generic message when the server did not return JSON.
    }
    if (response.status === 401 && path !== "/auth/login") clearAuthToken();
    throw new ApiError(response.status, message);
  }
  return response;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiResponse(path, options);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function apiBlob(path: string): Promise<Blob> {
  return (await apiResponse(path)).blob();
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}
