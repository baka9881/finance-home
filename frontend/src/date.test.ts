import { describe, expect, it } from "vitest";
import { taipeiDateInputValue, taipeiMonthInputValue } from "./date";

describe("Taipei date input values", () => {
  it("does not fall back to the previous UTC date after midnight in Taiwan", () => {
    const afterMidnightInTaipei = new Date("2026-08-18T17:54:00Z");
    expect(taipeiDateInputValue(afterMidnightInTaipei)).toBe("2026-08-19");
  });

  it("uses the Taipei month across a UTC month boundary", () => {
    const firstDayInTaipei = new Date("2026-07-31T16:30:00Z");
    expect(taipeiMonthInputValue(firstDayInTaipei)).toBe("2026-08");
  });
});
