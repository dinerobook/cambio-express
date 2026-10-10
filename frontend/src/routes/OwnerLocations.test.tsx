import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OwnerLocations from "./OwnerLocations";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { OwnerLocationsResponse } from "../api/owner";

// The owner umbrella's per-store grid. Pinned: owner / superadmin
// only; the period tab and search live in the URL (shareable) and
// drive the query; money renders through fmtMoney2 with a signed
// over/short; ErrorState retries.

const useOwnerLocations = vi.fn();
const refetch = vi.fn();
let state: { data?: OwnerLocationsResponse; isLoading: boolean; isError: boolean; error?: unknown };

vi.mock("../api/owner", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/owner")>();
  return {
    ...real,
    useOwnerLocations: (period: string, q: string) => {
      useOwnerLocations(period, q);
      return { ...state, refetch };
    },
  };
});

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.search}</p>;
}

function renderPage(url = "/owner/locations") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <OwnerLocations />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("OwnerLocations", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "owner", store_id: null });
    useOwnerLocations.mockReset();
    refetch.mockReset();
    state = {
      data: {
        rows: [
          {
            store_id: 1, store_name: "North", store_slug: "north", transfer_count: 1200,
            volume: 45000.5, over_short: -12.25, report_count: 30,
            companies: [{ company: "Intermex", count: 800, volume: 30000 }],
          },
          {
            store_id: 2, store_name: "South", store_slug: "south", transfer_count: 3,
            volume: 90, over_short: 4, report_count: 1, companies: [],
          },
        ],
        total: 2, matched: 2,
      },
      isLoading: false, isError: false,
    };
  });

  it("is closed to a store admin", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText(/Sign in as an owner/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders per-store stats with signed over/short", () => {
    renderPage();
    const north = screen.getByText("North").closest("tr")!;
    expect(north).toHaveTextContent("1,200");
    expect(north).toHaveTextContent("$45,000.50");
    expect(north).toHaveTextContent("-$12.25");
    expect(within(north).getByText("Intermex · 800")).toBeInTheDocument();
    expect(screen.getByText("South").closest("tr")).toHaveTextContent("+$4.00");
    expect(screen.getByText("2 of 2 stores")).toBeInTheDocument();
  });

  it("defaults to this month and moves the period into the URL", async () => {
    renderPage();
    expect(useOwnerLocations).toHaveBeenLastCalledWith("month", "");
    expect(screen.getByRole("tab", { name: "This month" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Today" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("period=today");
    expect(useOwnerLocations).toHaveBeenLastCalledWith("today", "");
  });

  it("searches on Enter with the trimmed text", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText("Search stores…"), "  nor {Enter}");
    expect(screen.getByTestId("loc")).toHaveTextContent("q=nor");
    expect(useOwnerLocations).toHaveBeenLastCalledWith("month", "nor");
  });

  it("explains an empty umbrella vs an empty search", () => {
    state = { data: { rows: [], total: 0, matched: 0 }, isLoading: false, isError: false };
    const { unmount } = renderPage();
    expect(screen.getByText("No stores connected yet")).toBeInTheDocument();
    unmount();
    state = { data: { rows: [], total: 4, matched: 0 }, isLoading: false, isError: false };
    renderPage("/owner/locations?q=zzz");
    expect(screen.getByText('No stores match "zzz".')).toBeInTheDocument();
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "Rollup failed", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Rollup failed");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});
