const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const API_BASE = configuredApiUrl ? `${configuredApiUrl}/api` : "/api";
const AUTH_TOKEN_KEY = "finance:authToken";

export const AUTH_REQUIRED = import.meta.env.VITE_AUTH_REQUIRED === "true";

export function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export function setAuthToken(token: string) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  window.dispatchEvent(new Event("finance:auth-changed"));
}

export function clearAuthToken() {
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

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
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
      message = payload.detail || message;
    } catch {
      // Keep the generic message when the server did not return JSON.
    }
    if (response.status === 401 && path !== "/auth/login") clearAuthToken();
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}
