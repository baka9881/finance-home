// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Button, DateInput, Dialog, Input, MonthInput } from "./ui";

afterEach(cleanup);

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>開啟</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="測試表單" description="說明文字">
        <Input aria-label="第一個欄位" />
        <Button>儲存</Button>
      </Dialog>
    </>
  );
}

describe("Dialog accessibility", () => {
  it("exposes dialog semantics, locks scrolling and closes with Escape", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "開啟" });
    await user.click(opener);

    expect(screen.getByRole("dialog", { name: "測試表單" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });
});

describe("custom date pickers", () => {
  it("selects a date from the calendar and updates the submitted value", async () => {
    const user = userEvent.setup();
    render(
      <form data-testid="form">
        <DateInput name="snapshot_date" defaultValue="2026-08-18" />
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "選擇日期" }));
    expect(screen.getByRole("dialog", { name: "選擇日期" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "2026年8月25日" }));

    expect(screen.queryByRole("dialog", { name: "選擇日期" })).toBeNull();
    expect(new FormData(screen.getByTestId("form") as HTMLFormElement).get("snapshot_date")).toBe("2026-08-25");
    expect(screen.getByText("2026年8月25日")).toBeTruthy();
  });

  it("uses a twelve-month panel instead of the browser month input", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [month, setMonth] = useState("2026-07");
      return <MonthInput value={month} onChange={(event) => setMonth(event.target.value)} />;
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "選擇月份" }));
    expect(screen.getByRole("dialog", { name: "選擇月份" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "8月" }));
    expect(screen.getByText("2026年8月")).toBeTruthy();
  });
});
