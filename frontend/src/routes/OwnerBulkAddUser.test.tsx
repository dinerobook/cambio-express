import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OwnerBulkAddUser from "./OwnerBulkAddUser";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Owner bulk add user: pick stores, submit once, read the per-store
// outcome. A whole-request failure is an error Alert and no results.

const useOwnerLocations = vi.fn();
const bulkAddUser = vi.fn();

vi.mock("../api/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/owner")>()),
  useOwnerLocations: () => useOwnerLocations(),
  bulkAddUser: (...a: unknown[]) => bulkAddUser(...a),
}));

const locations = {
  rows: [
    { store_id: 1, store_name: "Downtown", store_slug: "downtown" },
    { store_id: 2, store_name: "Uptown", store_slug: "uptown" },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OwnerBulkAddUser />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("manager@example.com"), "m@example.com");
  await user.type(screen.getByLabelText(/^Password/), "hunter22!");
}

describe("OwnerBulkAddUser", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "owner", store_id: null });
    useOwnerLocations.mockReset();
    bulkAddUser.mockReset();
    useOwnerLocations.mockReturnValue({
      data: locations, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("selects every store and reports each store's outcome", async () => {
    const user = userEvent.setup();
    bulkAddUser.mockResolvedValue({
      created: 1, skipped: 1, rejected: 0,
      results: [
        { store_id: 1, store_name: "Downtown", status: "created", detail: "" },
        { store_id: 2, store_name: "", status: "skipped", detail: "Already a member" },
      ],
    });
    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create user at 2 stores" }));

    expect(bulkAddUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "m@example.com", password: "hunter22!", store_ids: [1, 2],
    }));
    const results = await screen.findByRole("heading", { name: "Results" });
    const card = results.closest("section, div") as HTMLElement;
    expect(within(card).getByText("Created")).toBeInTheDocument();
    expect(within(card).getByText("Skipped")).toBeInTheDocument();
    expect(within(card).getByText("Store #2")).toBeInTheDocument();
    expect(within(card).getByText("Already a member")).toBeInTheDocument();
  });

  it("toggles a single store and shows a failed request as an error", async () => {
    const user = userEvent.setup();
    bulkAddUser.mockRejectedValue(new ApiError(400, "Password is too common.", null));
    renderPage();
    await fillForm(user);
    await user.click(screen.getByRole("checkbox", { name: /Uptown/ }));
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create user at 1 store" }));

    expect(bulkAddUser).toHaveBeenCalledWith(expect.objectContaining({ store_ids: [2] }));
    expect(await screen.findByText("Password is too common.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Results" })).not.toBeInTheDocument();
  });
});
