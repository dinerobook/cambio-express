import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { BulkResultsCard } from "./BulkResultsCard";

// The per-store outcome table of the owner bulk actions: one row per
// store, the status label + tone from one map, a "Store #id"
// fallback for a nameless store and "—" for an empty detail.

function rowFor(text: string) {
  return screen.getByText(text).closest("tr") as HTMLElement;
}

describe("<BulkResultsCard>", () => {
  it("renders Store / Status / Notes with one row per store", () => {
    render(
      <BulkResultsCard
        rows={[
          { store_id: 1, store_name: "Downtown", status: "created", detail: "" },
          { store_id: 2, store_name: "Uptown", status: "skipped", detail: "Already a member" },
          { store_id: 3, store_name: "Eastside", status: "rejected", detail: "Not in your umbrella" },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Store", "Status", "Notes"]);
    expect(screen.getAllByRole("row")).toHaveLength(4);

    expect(within(rowFor("Downtown")).getByText("Created")).toBeInTheDocument();
    expect(within(rowFor("Downtown")).getByText("—")).toBeInTheDocument();
    expect(within(rowFor("Uptown")).getByText("Skipped")).toBeInTheDocument();
    expect(within(rowFor("Uptown")).getByText("Already a member")).toBeInTheDocument();
    expect(within(rowFor("Eastside")).getByText("Rejected")).toBeInTheDocument();
  });

  it("tones each status by meaning, one map for every page", () => {
    render(
      <BulkResultsCard
        rows={[
          { store_id: 1, store_name: "A", status: "updated" },
          { store_id: 2, store_name: "B", status: "applied" },
          { store_id: 3, store_name: "C", status: "skipped" },
          { store_id: 4, store_name: "D", status: "rejected" },
          { store_id: 5, store_name: "E", status: "mystery" },
        ]}
      />,
    );
    // Same label + tone → same rendered pill. Completed writes all
    // share one look; skipped, rejected and unknown each differ.
    const pill = (label: string) => screen.getByText(label).getAttribute("style");
    expect(pill("Updated")).toBe(pill("Applied"));
    expect(pill("Skipped")).not.toBe(pill("Updated"));
    expect(pill("Rejected")).not.toBe(pill("Updated"));
    expect(pill("Rejected")).not.toBe(pill("Skipped"));
    // An unknown status shows its own slug rather than a guess.
    expect(within(rowFor("E")).getByText("mystery")).toBeInTheDocument();
  });

  it("falls back to Store #id and renders numeric details", () => {
    render(
      <BulkResultsCard
        detailLabel="Changes"
        rows={[
          { store_id: 7, store_name: undefined, status: "applied", detail: 0 },
          { store_id: 8, store_name: "", status: "rejected", detail: null },
        ]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Changes" })).toBeInTheDocument();
    expect(within(rowFor("Store #7")).getByText("0")).toBeInTheDocument();
    expect(within(rowFor("Store #8")).getByText("—")).toBeInTheDocument();
  });
});
