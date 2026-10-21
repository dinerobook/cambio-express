import { useState } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useNavigate } from "react-router-dom";
import { render } from "@testing-library/react";

import { Button, FormActions } from "../components/ui";
import { renderRouteWithGuard } from "../test/renderRoute";
import {
  activeUnsavedMessage, useDirtyBaseline, useUnsavedGuard,
  withoutUnsavedPrompt,
} from "./useUnsavedGuard";

describe("useUnsavedGuard", () => {
  it("runs proceed immediately when clean (no dialog)", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedGuard(false));
    act(() => result.current.confirmLeave(proceed));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it("stages the dialog when dirty and defers proceed until confirmed", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedGuard(true));

    act(() => result.current.confirmLeave(proceed));
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.dialogProps.open).toBe(true);

    act(() => result.current.dialogProps.onConfirm());
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it("cancelling the dialog does not proceed and closes it", () => {
    const proceed = vi.fn();
    const { result } = renderHook(() => useUnsavedGuard(true));

    act(() => result.current.confirmLeave(proceed));
    act(() => result.current.dialogProps.onCancel());
    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.dialogProps.open).toBe(false);
  });

  it("honors custom title/message overrides", () => {
    const { result } = renderHook(() =>
      useUnsavedGuard(true, { title: "T", message: "M" }),
    );
    expect(result.current.dialogProps.title).toBe("T");
    expect(result.current.dialogProps.message).toBe("M");
  });

  it("arms the browser prompt only while dirty", () => {
    const { rerender, unmount } = renderHook(
      ({ dirty }) => useUnsavedGuard(dirty),
      { initialProps: { dirty: false } },
    );
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    rerender({ dirty: true });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    unmount();
    const gone = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(gone);
    expect(gone.defaultPrevented).toBe(false);
  });

  it("registers the dirty form for the router blocker and drops it when clean", () => {
    const { rerender, unmount } = renderHook(
      ({ dirty }) => useUnsavedGuard(dirty, { message: "Batch edits" }),
      { initialProps: { dirty: true } },
    );
    expect(activeUnsavedMessage()).toBe("Batch edits");
    rerender({ dirty: false });
    expect(activeUnsavedMessage()).toBeNull();
    rerender({ dirty: true });
    unmount();
    expect(activeUnsavedMessage()).toBeNull();
  });

  it("withoutUnsavedPrompt hides the dirty form only for the call", () => {
    const { unmount } = renderHook(() => useUnsavedGuard(true));
    let during: string | null = "unset";
    withoutUnsavedPrompt(() => { during = activeUnsavedMessage(); });
    expect(during).toBeNull();
    expect(activeUnsavedMessage()).not.toBeNull();
    unmount();
  });
});

describe("useDirtyBaseline", () => {
  it("is clean until the values change, and clean again after markSaved", () => {
    const { result } = renderHook(() => {
      const [name, setName] = useState("a");
      return { name, setName, ...useDirtyBaseline({ name }) };
    });
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setName("b"));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.setName("a"));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setName("c"));
    act(() => result.current.markSaved());
    expect(result.current.dirty).toBe(false);
  });

  it("takes the baseline only once ready (the hydrated values)", () => {
    const { result } = renderHook(() => {
      const [state, setState] = useState({ name: "", ready: false });
      return { state, setState, ...useDirtyBaseline({ name: state.name }, state.ready) };
    });
    expect(result.current.dirty).toBe(false);
    // Hydrate: the loaded value arrives together with ready.
    act(() => result.current.setState({ name: "Loaded", ready: true }));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setState({ name: "Edited", ready: true }));
    expect(result.current.dirty).toBe(true);
  });
});

// ── Router blocker + FormActions, end to end ─────────────────────────

function Form({ onSave }: { onSave?: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const { dirty } = useDirtyBaseline({ name });
  const guard = useUnsavedGuard(dirty && !saving, {
    message: "You have unsaved edits on this test form. Leave without saving?",
  });
  const navigate = useNavigate();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        onSave?.();
        guard.proceed(() => navigate("/saved"));
      }}
    >
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <Link to="/elsewhere">Sidebar link</Link>
      <Link to="/form?tab=2">Other tab</Link>
      <FormActions guard={guard} note="Saves every field.">
        <Button
          tone="secondary"
          onClick={() => guard.confirmLeave(() => navigate("/list"))}
        >
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </FormActions>
    </form>
  );
}

describe("unsaved-changes guard on a page", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows the note while clean and the pinned Unsaved changes bar while dirty", async () => {
    const user = userEvent.setup();
    renderRouteWithGuard(<Form />, { path: "/form" });
    expect(screen.getByText("Saves every field.")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    await user.type(screen.getByLabelText("Name"), "Ana");
    const pill = screen.getByText("Unsaved changes");
    expect(pill.closest(".ds-form-actions")).toHaveClass("ds-form-actions--sticky");
    expect(screen.queryByText("Saves every field.")).toBeNull();
  });

  it("a clean form leaves without any prompt", async () => {
    const user = userEvent.setup();
    renderRouteWithGuard(<Form />, { path: "/form" });
    await user.click(screen.getByText("Sidebar link"));
    expect(await screen.findByText("Navigated to /elsewhere")).toBeInTheDocument();
  });

  it("holds a sidebar link while dirty; Keep editing stays, Leave goes", async () => {
    const user = userEvent.setup();
    renderRouteWithGuard(<Form />, { path: "/form" });
    await user.type(screen.getByLabelText("Name"), "Ana");

    await user.click(screen.getByText("Sidebar link"));
    expect(await screen.findByText(
      "You have unsaved edits on this test form. Leave without saving?",
    )).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Name")).toHaveValue("Ana");

    await user.click(screen.getByText("Sidebar link"));
    await user.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByText("Navigated to /elsewhere")).toBeInTheDocument();
  });

  it("holds the browser back button", async () => {
    const user = userEvent.setup();
    const { router } = renderRouteWithGuard(<Form />, { path: "/form", from: "/list" });
    await user.type(screen.getByLabelText("Name"), "Ana");
    act(() => { void router.navigate(-1); });
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe("/form");
    expect(screen.getByLabelText("Name")).toHaveValue("Ana");
  });

  it("holds a programmatic navigation too", async () => {
    const user = userEvent.setup();
    const { router } = renderRouteWithGuard(<Form />, { path: "/form" });
    await user.type(screen.getByLabelText("Name"), "Ana");

    act(() => { void router.navigate("/elsewhere"); });
    expect(await screen.findByRole("button", { name: "Leave" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/form");
  });

  it("lets a query-string change on the same page through (tabs, list filters)", async () => {
    const user = userEvent.setup();
    const { router } = renderRouteWithGuard(<Form />, { path: "/form" });
    await user.type(screen.getByLabelText("Name"), "Ana");
    await user.click(screen.getByText("Other tab"));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=2"));
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveValue("Ana");
  });

  it("the form's Cancel asks once (no second prompt from the router)", async () => {
    const user = userEvent.setup();
    renderRouteWithGuard(<Form />, { path: "/form" });
    await user.type(screen.getByLabelText("Name"), "Ana");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Leave" }));
    expect(await screen.findByText("Navigated to /list")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigating away after a save never prompts", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderRouteWithGuard(<Form onSave={onSave} />, { path: "/form" });
    await user.type(screen.getByLabelText("Name"), "Ana");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalled();
    expect(await screen.findByText("Navigated to /saved")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders without a data router (component tests) and still guards Cancel", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><Form /></MemoryRouter>);
    await user.type(screen.getByLabelText("Name"), "Ana");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Keep editing" })).toBeInTheDocument();
  });
});
