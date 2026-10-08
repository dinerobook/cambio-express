import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ImpersonationBannerView } from "./ImpersonationBanner";

describe("<ImpersonationBannerView>", () => {
  it("names who the superadmin is acting as and who is behind it", () => {
    render(
      <ImpersonationBannerView
        actingAs="Maria Lopez" role="admin" storeName="Cambio Express"
        byName="Platform Admin" onExit={vi.fn()}
      />,
    );
    expect(screen.getByText(/signed in as a customer/i)).toBeInTheDocument();
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.getByText(/Cambio Express/)).toBeInTheDocument();
    expect(screen.getByText(/via superadmin Platform Admin/)).toBeInTheDocument();
  });

  it("exit fires the handler and shows the button busy while it runs", async () => {
    let resolve: () => void = () => {};
    const onExit = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(
      <ImpersonationBannerView
        actingAs="Maria Lopez" role="admin" storeName=""
        byName="" onExit={onExit}
      />,
    );
    const btn = screen.getByRole("button", { name: /exit impersonation/i });
    await userEvent.click(btn);
    expect(onExit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(btn).toBeDisabled());
    resolve();
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});
