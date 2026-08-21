// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Button, Dialog, Input } from "./ui";

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
