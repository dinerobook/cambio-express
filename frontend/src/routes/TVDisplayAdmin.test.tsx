import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TVDisplayAdmin, {
  TVDisplayDevice, TVDisplayOverview,
} from "./TVDisplayAdmin";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// TV Display console. Pinned here:
//   - The layout's load failure is an ErrorState whose Retry refetches;
//     a 409 (add-on off) explains how to turn it on instead.
//   - The public URL is the kit CopyField: it copies, and says so.
//   - Rotating the URL needs settings.update — without it the button
//     is not there at all (no access, no control).
//   - "At a glance" totals the countries' banks and rate cells.

const overview = vi.fn();
const mutation = () => ({
  mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null,
});

vi.mock("../api/tvDisplay", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/tvDisplay")>();
  return {
    ...real,
    useTVDisplayOverview: () => overview(),
    useRegenerateTVDisplayToken: () => mutation(),
    useSaveTVDisplaySettings: () => mutation(),
    useClaimTVPairCode: () => mutation(),
    useRevokeTVPairing: () => mutation(),
    useCreateTVDisplayCountry: () => mutation(),
    useDeleteTVDisplayCountry: () => mutation(),
  };
});

const DATA = {
  display_id: 1,
  title: "Cheapest Money Transfer",
  subtitle: "",
  orientation: "auto",
  theme: "dark",
  public_token: "tok",
  public_url: "https://dinerobook.test/tv/tok",
  last_updated_at: "2026-10-08T14:00:00",
  countries: [
    { id: 1, country_code: "MX", country_name: "Mexico", sort_order: 0,
      mt_companies: "", bank_count: 3, rate_count: 7 },
    { id: 2, country_code: "GT", country_name: "Guatemala", sort_order: 1,
      mt_companies: "", bank_count: 2, rate_count: 4 },
  ],
  active_pairing: null,
};

function loaded() {
  return {
    data: DATA, isLoading: false, isError: false, error: null,
    refetch: vi.fn(),
  };
}

function renderAt(ui: React.ReactNode) {
  return render(
    <ToastProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </ToastProvider>,
  );
}

describe("TVDisplayAdmin", () => {
  beforeEach(() => {
    overview.mockReset();
    overview.mockReturnValue(loaded());
  });
  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: undefined,
    });
  });

  it("shows the tabs once the overview loads", () => {
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/tv-display/overview"]}>
          <Routes>
            <Route path="/tv-display" element={<TVDisplayAdmin />}>
              <Route path="overview" element={<p>overview tab</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("overview tab")).toBeInTheDocument();
  });

  it("a load failure offers a Retry that refetches", async () => {
    const refetch = vi.fn();
    overview.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "boom", null), refetch,
    });
    renderAt(<TVDisplayAdmin />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the TV display.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("an inactive add-on (409) points at the subscription page", () => {
    overview.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(409, "addon off", null), refetch: vi.fn(),
    });
    renderAt(<TVDisplayAdmin />);
    expect(screen.getByText(/isn't active for this store/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("copies the public display URL", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText },
    });
    renderAt(<TVDisplayOverview />);
    expect(screen.getByLabelText("Public display URL")).toHaveValue(DATA.public_url);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DATA.public_url));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("offers to rotate the URL to someone who can change settings", () => {
    renderAt(<TVDisplayOverview />);
    expect(
      screen.getByRole("button", { name: "Regenerate display URL" }),
    ).toBeInTheDocument();
  });

  it("hides the rotate button from someone who can only view", () => {
    setCurrentIdentity({ ...TEST_ADMIN, permissions: ["settings.read"] });
    renderAt(<TVDisplayOverview />);
    // The URL itself is still there to copy…
    expect(screen.getByLabelText("Public display URL")).toBeInTheDocument();
    // …but the destructive control is gone, not disabled.
    expect(
      screen.queryByRole("button", { name: "Regenerate display URL" }),
    ).toBeNull();
  });

  it("totals banks and rate cells across countries at a glance", () => {
    renderAt(<TVDisplayDevice />);
    expect(screen.getByText("Country sections").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Payout banks").parentElement).toHaveTextContent("5");
    expect(screen.getByText("Rate cells filled").parentElement).toHaveTextContent("11");
    expect(screen.getByText("Subscription").parentElement).toHaveTextContent("$5/mo");
  });
});
