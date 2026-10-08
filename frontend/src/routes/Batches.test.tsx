import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Batches from "./Batches";
import { BATCH_STATUS_TONES } from "../api/batches";
import { Pill, type PillTone } from "../components/ui";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// ACH batches list: money columns follow invariant 9
// (transfers_total = sum of send_amount + federal_tax, computed by the
// server), variance is signed, status uses the shared tone map, sort
// lives in the URL, and "+ New batch" needs batches.create.

const useBatches = vi.fn();

vi.mock("../api/batches", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/batches")>();
  return {
    ...real,
    useBatches: (s: string, d: string) => useBatches(s, d),
  };
});

const base = {
  company: "Intermex", reconciled: false, transfer_dates: "", notes: "",
};
const rows = [
  {
    ...base, id: 1, ach_date: "2026-10-01", batch_ref: "REF-1",
    ach_amount: 1000, transfers_total: 1050.5, variance: -50.5,
    transfer_count: 4, status: "Pending",
  },
  {
    ...base, id: 2, ach_date: "2026-09-20", batch_ref: "REF-2",
    company: "Maxi", ach_amount: 800, transfers_total: 800, variance: 0,
    transfer_count: 2, status: "Cleared",
  },
  {
    ...base, id: 3, ach_date: "2026-09-10", batch_ref: "REF-3",
    ach_amount: 300, transfers_total: 250, variance: 50,
    transfer_count: 1, status: "Mystery",
  },
];

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname}{l.search}</div>;
}

function renderPage(path = "/batches") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<><Batches /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The inline style the shared Pill paints for a tone.
function pillStyle(tone: PillTone) {
  const { unmount, container } = render(<Pill tone={tone}>x</Pill>);
  const css = container.firstElementChild!.getAttribute("style");
  unmount();
  return css;
}

describe("Batches list", () => {
  beforeEach(() => {
    useBatches.mockReset();
    useBatches.mockReturnValue({
      data: { rows }, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("shows each batch's ACH amount, transfers total, count and variance", () => {
    renderPage();
    const r1 = screen.getByLabelText("Open batch REF-1");
    expect(r1).toHaveTextContent("$1,000.00");
    expect(r1).toHaveTextContent("$1,050.50");
    expect(r1).toHaveTextContent("(4)");
    expect(r1).toHaveTextContent("-$50.50");
    // Matched batch reads "+$0.00", over-paid carries a plus sign.
    expect(screen.getByLabelText("Open batch REF-2")).toHaveTextContent("+$0.00");
    expect(screen.getByLabelText("Open batch REF-3")).toHaveTextContent("+$50.00");
    expect(screen.getByText("3 batches")).toBeInTheDocument();
  });

  it("renders status pills with the shared tone map", () => {
    renderPage();
    const pending = within(screen.getByLabelText("Open batch REF-1")).getByText("Pending");
    const cleared = within(screen.getByLabelText("Open batch REF-2")).getByText("Cleared");
    const unknown = within(screen.getByLabelText("Open batch REF-3")).getByText("Mystery");
    expect(pending.getAttribute("style")).toBe(pillStyle(BATCH_STATUS_TONES.Pending));
    expect(cleared.getAttribute("style")).toBe(pillStyle(BATCH_STATUS_TONES.Cleared));
    // Unknown statuses fall back to neutral rather than crashing.
    expect(unknown.getAttribute("style")).toBe(pillStyle("neutral"));
    expect(pending.getAttribute("style")).not.toBe(cleared.getAttribute("style"));
  });

  it("sorts through the header buttons and the URL, toggling direction", async () => {
    renderPage();
    expect(useBatches).toHaveBeenLastCalledWith("", "desc");
    await userEvent.click(screen.getByRole("button", { name: "ACH amount" }));
    expect(useBatches).toHaveBeenLastCalledWith("ach_amount", "asc");
    expect(screen.getByTestId("loc")).toHaveTextContent("?sort=ach_amount&dir=asc");
    await userEvent.click(screen.getByRole("button", { name: /^ACH amount/ }));
    expect(useBatches).toHaveBeenLastCalledWith("ach_amount", "desc");
    expect(screen.getByRole("columnheader", { name: /ACH amount/ }))
      .toHaveAttribute("aria-sort", "descending");
  });

  it("opens the batch's edit page when its row is clicked", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Open batch REF-2"));
    expect(screen.getByTestId("loc")).toHaveTextContent("/batches/2/edit");
  });

  it("offers + New batch only with batches.create", () => {
    const { unmount } = renderPage();
    expect(screen.getByRole("link", { name: /New batch/ })).toBeInTheDocument();
    unmount();
    setCurrentIdentity({
      ...TEST_ADMIN,
      permissions: TEST_ADMIN.permissions.filter((p) => p !== "batches.create"),
    });
    renderPage();
    expect(screen.queryByRole("link", { name: /New batch/ })).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no batches", () => {
    useBatches.mockReturnValue({
      data: { rows: [] }, isLoading: false, isError: false, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("No ACH batches yet.")).toBeInTheDocument();
  });

  it("asks a storeless login to sign in as a store admin", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText(/Sign in as a store admin/)).toBeInTheDocument();
  });
});
