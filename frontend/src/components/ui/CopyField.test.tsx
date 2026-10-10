import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CopyButton, CopyField } from "./CopyField";
import { ToastProvider } from "./Toast";

// One copy affordance for share links, invite codes and display
// URLs: copies through the Clipboard API, falls back to
// execCommand, flips to "Copied", and owns up when both fail.

function setClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function renderField(ui: React.ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("<CopyField>", () => {
  const originalExec = document.execCommand;

  beforeEach(() => {
    // jsdom has no execCommand; tests opt in per case.
    document.execCommand = vi.fn(() => false);
  });
  afterEach(() => {
    document.execCommand = originalExec;
    setClipboard(undefined);
    vi.useRealTimers();
  });

  it("shows the value read-only with its label", () => {
    setClipboard(vi.fn(() => Promise.resolve()));
    renderField(<CopyField label="Share link" value="https://x.test/r/ABC" />);
    const input = screen.getByLabelText("Share link") as HTMLInputElement;
    expect(input.value).toBe("https://x.test/r/ABC");
    expect(input).toHaveAttribute("readonly");
  });

  it("copies the value and flips the button to Copied, then back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    renderField(<CopyField aria-label="Invite code" value="ABCD1234" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith("ABCD1234");

    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("falls back to execCommand when the Clipboard API is missing", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    renderField(<CopyField aria-label="URL" value="https://tv.test/x" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument(),
    );
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("on failure says so in a toast and selects the text — never 'Copied'", async () => {
    setClipboard(vi.fn(() => Promise.reject(new Error("denied"))));
    renderField(<CopyField aria-label="URL" value="https://tv.test/x" />);
    const input = screen.getByLabelText("URL") as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      await screen.findByText(/Couldn't copy/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("https://tv.test/x".length);
  });

  it("renders extra actions after the copy button", () => {
    setClipboard(vi.fn(() => Promise.resolve()));
    renderField(
      <CopyField
        aria-label="URL" value="https://tv.test/x" copyLabel="Copy link"
        actions={<a href="https://tv.test/x">Open</a>}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toBeInTheDocument();
  });
});

describe("<CopyButton>", () => {
  afterEach(() => setClipboard(undefined));

  it("copies its own text, not a neighbouring field's", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    renderField(<CopyButton text="REF123" label="Copy code" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("REF123"));
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });
});
