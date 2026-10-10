import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TVDisplayCountry from "./TVDisplayCountry";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// TV rate board country editor. Save used to post an HTML form to a
// server route that no longer exists, so every edit was lost. Pinned:
//   - Save sends the whole editor in one call (header, columns,
//     bank edits / deletes, new banks, rates; blank cell = null).
//   - A typo in a rate is caught before anything is sent.
//   - A refusal shows the server's reason and stays on the page.
//   - Without settings.update there is no Save button.

const mutateAsync = vi.fn();
const useTVDisplayCountryDetail = vi.fn();

vi.mock("../api/tvDisplay", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/tvDisplay")>();
  return {
    ...real,
    useTVDisplayCountryDetail: (...a: unknown[]) => useTVDisplayCountryDetail(...a),
    useUpdateTVDisplayCountry: () => ({ mutateAsync, isPending: false }),
  };
});

const data = {
  id: 7, country_code: "MX", country_name: "Mexico", sort_order: 0,
  mt_companies: ["Maxi", "Vigo"],
  banks: [
    { id: 1, bank_name: "Bancomer", sort_order: 10, rates: { Maxi: 18.5, Vigo: 18.2 } },
    { id: 2, bank_name: "Banorte", sort_order: 20, rates: { Maxi: 18.4 } },
  ],
};

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/tv-display/countries/7"]}>
        <Routes>
          <Route path="/tv-display/countries/:countryId" element={<TVDisplayCountry />} />
          <Route path="/tv-display" element={<p>TV display home</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const rateInput = (bankId: number, idx: number) =>
  document.querySelector<HTMLInputElement>(`input[name="rate-${bankId}-${idx}"]`)!;

describe("TVDisplayCountry", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(data);
    useTVDisplayCountryDetail.mockReset();
    useTVDisplayCountryDetail.mockReturnValue({
      data, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
  });

  it("asks for the country in the URL", () => {
    renderPage();
    expect(useTVDisplayCountryDetail).toHaveBeenCalledWith(7);
    expect(rateInput(1, 0)).toHaveValue("18.5");
    expect(rateInput(2, 1)).toHaveValue("");
  });

  it("saves the whole editor in one call and returns to the TV page", async () => {
    renderPage();
    await userEvent.clear(rateInput(1, 0));
    await userEvent.type(rateInput(1, 0), "18.75");
    await userEvent.type(rateInput(2, 1), "18.1");
    await userEvent.clear(rateInput(1, 1));
    await userEvent.click(screen.getAllByRole("checkbox", { name: "delete" })[1]);
    await userEvent.type(
      screen.getByPlaceholderText("Bank name (leave blank to skip)"), "Elektra",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({
      country_name: "Mexico",
      country_code: "MX",
      mt_companies: ["Maxi", "Vigo"],
      banks: [
        { id: 1, bank_name: "Bancomer", sort_order: 10, delete: false,
          rates: { Maxi: 18.75, Vigo: null } },
        { id: 2, bank_name: "Banorte", sort_order: 20, delete: true,
          rates: { Maxi: 18.4, Vigo: 18.1 } },
      ],
      new_banks: ["Elektra"],
    });
    expect(await screen.findByText("TV display home")).toBeInTheDocument();
    expect(screen.getByText("Country saved.")).toBeInTheDocument();
  });

  it("catches a rate that is not a number before sending", async () => {
    renderPage();
    await userEvent.type(rateInput(2, 1), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/"abc" isn't a rate/)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("shows the server's reason and stays on the page when refused", async () => {
    mutateAsync.mockRejectedValue(new ApiError(404, "Bank not found", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Bank not found")).toBeInTheDocument();
    expect(screen.queryByText("TV display home")).not.toBeInTheDocument();
  });

  it("hides Save from someone who can only view settings", () => {
    setCurrentIdentity({
      ...TEST_ADMIN,
      permissions: TEST_ADMIN.permissions.filter((p) => p !== "settings.update"),
    });
    renderPage();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("offers a retry when the country cannot load", () => {
    useTVDisplayCountryDetail.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(404, "Country not found", null), refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText(/Country not found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
