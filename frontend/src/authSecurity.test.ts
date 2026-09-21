import { describe, expect, it } from "vitest";
import { resolveAuthGate, type AuthStatus } from "./api";

const localStatus: AuthStatus = {
  required: false,
  authenticated: true,
  session_expires_at: null,
  data_location: "local",
};

describe("authentication gate", () => {
  it("keeps password-free local development available", () => {
    expect(resolveAuthGate(localStatus, false)).toBe("authenticated");
  });

  it("rejects an unprotected backend in a cloud build", () => {
    expect(resolveAuthGate(localStatus, true)).toBe("configuration-error");
  });

  it("requires a valid hosted session before showing financial pages", () => {
    const hostedStatus: AuthStatus = {
      required: true,
      authenticated: false,
      session_expires_at: null,
      data_location: "cloud",
    };
    expect(resolveAuthGate(hostedStatus, true)).toBe("anonymous");
    expect(
      resolveAuthGate(
        {
          ...hostedStatus,
          authenticated: true,
          session_expires_at: "2026-10-21T12:00:00+00:00",
        },
        true,
      ),
    ).toBe("authenticated");
  });
});
