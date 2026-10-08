import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReturnChecks from "./ReturnChecks";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Returned-checks list: the status filter is the kit tab strip and
// lives in the URL (shareable), each row shows its money and status
// with the shared tone map, and a fully recovered check is marked.

const useReturnChecks = vi.fn();

vi.mock("../api/returnChecks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/returnChecks")>();
  return { ...real, useReturnChecks: (s: string) => useReturnChecks(s) };
});

const rows = [
  {
    id: 1, bounced_on: "2026-10-02", customer_name: "Ana Ruiz",
    company_name: "", check_number: "1042", payer_bank: "Chase",
    amount: 500, return_check_fee: 25, status: "pending",
    status_changed_on: "", notes: "", recovered_total: 100, payment_count: 1,
  },
  {
    id: 2, bounced_on: "2026-09-15", customer_name: "Luis Mora",
    company_name: "", check_number: "", payer_bank: "",
    amount: 1200, return_check_fee: 0, status: "recovered",
    status_changed_on: "", notes: "", recovered_total: 1200, payment_count: 3,
  },
];

function LocationProbe() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderPage(path = "/return-checks") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/return-checks"
            element={<><ReturnChecks /><LocationProbe /></>}
          />
          <Route path="/return-checks/:id/edit" element={<div>edit page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ReturnChecks list", () => {
  beforeEach(() => {
    useReturnChecks.mockReset();
    useReturnChecks.mockReturnValue({
      data: { rows }, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("renders each check's money, date and status", () => {
    renderPage();
    const ana = screen.getByText("Ana Ruiz").closest("tr")!;
    expect(ana).toHaveTextContent("$500.00");
    expect(ana).toHaveTextContent("$100.00");
    expect(ana).toHaveTextContent("Oct 2, 2026");
    expect(within(ana).getByText("Pending")).toBeInTheDocument();
    const luis = screen.getByText("Luis Mora").closest("tr")!;
    expect(luis).toHaveTextContent("$1,200.00");
    expect(within(luis).getByText("Recovered")).toBeInTheDocument();
  });

  it("filters by status through the tab strip and the URL", async () => {
    renderPage();
    expect(useReturnChecks).toHaveBeenLastCalledWith("");
    const tabs = screen.getByRole("tablist");
    expect(within(tabs).getByRole("tab", { name: "All" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(tabs).getByRole("tab", { name: "Fraud" }));
    expect(useReturnChecks).toHaveBeenLastCalledWith("fraud");
    expect(screen.getByTestId("search")).toHaveTextContent("?status=fraud");
    expect(within(tabs).getByRole("tab", { name: "Fraud" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(tabs).getByRole("tab", { name: "All" }));
    expect(useReturnChecks).toHaveBeenLastCalledWith("");
    expect(screen.getByTestId("search")).toHaveTextContent(/^$/);
  });

  it("reads the filter from a shared link", () => {
    renderPage("/return-checks?status=loss");
    expect(useReturnChecks).toHaveBeenLastCalledWith("loss");
  });

  it("opens the check when its row is clicked", async () => {
    renderPage();
    await userEvent.click(screen.getByText("Ana Ruiz"));
    expect(screen.getByText("edit page")).toBeInTheDocument();
  });

  it("asks a storeless login to sign in as a store admin", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText(/Sign in as a store admin/)).toBeInTheDocument();
  });
});
