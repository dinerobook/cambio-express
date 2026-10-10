import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TwoFactorEnroll, TwoFactorRecover, TwoFactorVerify } from "./TwoFactor";
import { ApiError } from "../lib/api";

// The /login/2fa/* screens (CLAUDE.md invariant #13). Pinned:
//   - without a pending token in router state each screen bounces
//     to /login and never calls the API;
//   - verify / recover POST the pending token + trimmed code and
//     only a response carrying an access token finishes sign-in;
//   - enrollment shows the secret, then the one-time recovery
//     codes, and only finishes after "I've saved these" is ticked.

const api = vi.fn();
const setAccessToken = vi.fn();
const totpEnrollStart = vi.fn();
const totpEnrollFinish = vi.fn();
const totpEnrollConfirm = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: (...a: unknown[]) => api(...a) };
});
vi.mock("../lib/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/auth")>();
  return { ...real, setAccessToken: (t: string) => setAccessToken(t) };
});
vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    totpEnrollStart: (...a: unknown[]) => totpEnrollStart(...a),
    totpEnrollFinish: (...a: unknown[]) => totpEnrollFinish(...a),
    totpEnrollConfirm: (...a: unknown[]) => totpEnrollConfirm(...a),
  };
});

const PENDING = { pending_token: "pend-1", has_recovery_codes: true };

function renderAt(path: string, state: unknown = PENDING) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/dashboard" element={<p>dashboard page</p>} />
        <Route path="/login/2fa" element={<TwoFactorVerify />} />
        <Route path="/login/2fa/recover" element={<TwoFactorRecover />} />
        <Route path="/login/2fa/enroll" element={<TwoFactorEnroll />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.mockReset();
  setAccessToken.mockReset();
  totpEnrollStart.mockReset();
  totpEnrollFinish.mockReset();
  totpEnrollConfirm.mockReset();
});

describe("TwoFactorVerify", () => {
  it("bounces to /login without a pending token", async () => {
    renderAt("/login/2fa", null);
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it("verifies the code and lands on the dashboard", async () => {
    api.mockResolvedValue({ access_token: "jwt-1" });
    renderAt("/login/2fa");
    await userEvent.type(screen.getByLabelText("Authentication code"), "123 456");
    await userEvent.click(screen.getByRole("button", { name: "Verify →" }));
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/v2/auth/login/totp", {
      method: "POST", json: { pending_token: "pend-1", code: "123 456" },
    });
    expect(setAccessToken).toHaveBeenCalledWith("jwt-1");
  });

  it("shows the refusal and does not sign in", async () => {
    api.mockRejectedValue(new ApiError(401, "Invalid code.", null));
    renderAt("/login/2fa");
    await userEvent.type(screen.getByLabelText("Authentication code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify →" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid code.");
    expect(setAccessToken).not.toHaveBeenCalled();
  });

  it("refuses a response without an access token", async () => {
    api.mockResolvedValue({});
    renderAt("/login/2fa");
    await userEvent.type(screen.getByLabelText("Authentication code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify →" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("unexpected response");
    expect(screen.queryByText("dashboard page")).not.toBeInTheDocument();
  });

  it("offers the recovery link only when the person has recovery codes", () => {
    renderAt("/login/2fa", { pending_token: "p", has_recovery_codes: false });
    expect(screen.queryByRole("link", { name: "Use a recovery code" })).not.toBeInTheDocument();
  });
});

describe("TwoFactorRecover", () => {
  it("posts the recovery code to the recovery endpoint", async () => {
    api.mockResolvedValue({ access_token: "jwt-2" });
    renderAt("/login/2fa/recover");
    await userEvent.type(screen.getByLabelText("Recovery code"), " ABCD-EFGH ");
    await userEvent.click(screen.getByRole("button", { name: "Use code →" }));
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/v2/auth/login/recovery", {
      method: "POST", json: { pending_token: "pend-1", code: "ABCD-EFGH" },
    });
  });
});

describe("TwoFactorEnroll", () => {
  const enrollment = {
    qr_svg: "<svg></svg>", issuer: "DineroBook", username: "root",
    secret_chunks: "ABCD EFGH IJKL", secret: "ABCDEFGHIJKL",
  };

  it("bounces to /login without a pending token", async () => {
    renderAt("/login/2fa/enroll", null);
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(totpEnrollStart).not.toHaveBeenCalled();
  });

  it("shows the start refusal", async () => {
    totpEnrollStart.mockRejectedValue(new ApiError(401, "Session expired.", null));
    renderAt("/login/2fa/enroll");
    expect(await screen.findByRole("alert")).toHaveTextContent("Session expired.");
  });

  it("walks scan → recovery codes → finish only after the codes are saved", async () => {
    totpEnrollStart.mockResolvedValue(enrollment);
    totpEnrollFinish.mockResolvedValue({ recovery_codes: ["AAAA-1111", "BBBB-2222"] });
    totpEnrollConfirm.mockResolvedValue({ access_token: "jwt-3", role: "superadmin", store_id: null });
    renderAt("/login/2fa/enroll");

    expect(await screen.findByText("ABCD EFGH IJKL")).toBeInTheDocument();
    expect(totpEnrollStart).toHaveBeenCalledWith("pend-1");
    await userEvent.type(screen.getByLabelText(/Enter the 6-digit code/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm and continue →" }));

    expect(await screen.findByText("AAAA-1111")).toBeInTheDocument();
    expect(totpEnrollFinish).toHaveBeenCalledWith("pend-1", "123456");
    const finish = screen.getByRole("button", { name: "Finish and sign in →" });
    expect(finish).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(finish);

    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(setAccessToken).toHaveBeenCalledWith("jwt-3");
  });

  it("keeps the person on the scan step when the code is refused", async () => {
    totpEnrollStart.mockResolvedValue(enrollment);
    totpEnrollFinish.mockRejectedValue(new ApiError(400, "Code did not match.", null));
    renderAt("/login/2fa/enroll");
    await userEvent.type(await screen.findByLabelText(/Enter the 6-digit code/), "999999");
    await userEvent.click(screen.getByRole("button", { name: "Confirm and continue →" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Code did not match.");
    await waitFor(() => expect(totpEnrollConfirm).not.toHaveBeenCalled());
    expect(screen.getByText("ABCD EFGH IJKL")).toBeInTheDocument();
  });
});
