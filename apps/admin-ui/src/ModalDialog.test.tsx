import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "./ModalDialog.js";

describe("ModalDialog keyboard focus boundary", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("focuses the first action, traps Tab in both directions, and restores the trigger", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    trigger.focus();
    fireEvent.click(trigger);
    await flushAnimationFrame();

    const first = screen.getByRole("button", { name: "Confirm" });
    const last = screen.getByRole("button", { name: "Cancel" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not close on Escape while cancellation is disabled", async () => {
    render(<DialogHarness cancelDisabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    await flushAnimationFrame();

    fireEvent.keyDown(screen.getByRole("button", { name: "Confirm" }), { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Confirmation" })).toBeInTheDocument();
  });

  it("keeps focus inside the dialog when every action is disabled", async () => {
    render(<DialogHarness cancelDisabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    await flushAnimationFrame();

    const dialog = screen.getByRole("dialog", { name: "Confirmation" });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
  });

  it("moves focus back to an action when controls are re-enabled", async () => {
    const { rerender } = render(<DialogHarness cancelDisabled />);
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    await flushAnimationFrame();
    const dialog = screen.getByRole("dialog", { name: "Confirmation" });
    expect(dialog).toHaveFocus();

    rerender(<DialogHarness />);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });
});

function DialogHarness({ cancelDisabled = false }: { cancelDisabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open confirmation
      </button>
      {!open ? null : (
        <ModalDialog
          label="Confirmation"
          cancelDisabled={cancelDisabled}
          onCancel={() => {
            setOpen(false);
          }}
        >
          <button type="button" disabled={cancelDisabled}>
            Confirm
          </button>
          <button
            type="button"
            disabled={cancelDisabled}
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </button>
        </ModalDialog>
      )}
    </>
  );
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        resolve();
      })
    );
  });
}
