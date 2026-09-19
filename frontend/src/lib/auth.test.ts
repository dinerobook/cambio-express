import { beforeEach, describe, expect, it } from "vitest";

import {
  getCurrentIdentity, persistLoginResponse, syncPermissions,
} from "./auth";

// syncPermissions is how the shell adopts the server's live
// permission list over the one cached at login, so a revoke reaches
// the nav and route guard before the access token expires.
describe("syncPermissions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    persistLoginResponse({
      user_id: 7, username: "amber", full_name: "Amber",
      role: "employee", store_id: 1,
      permissions: ["transfers.read", "daily_book.read"],
    });
  });

  it("replaces the cached list when the live one differs", () => {
    expect(syncPermissions(["transfers.read"])).toBe(true);
    expect(getCurrentIdentity()?.permissions).toEqual(["transfers.read"]);
  });

  it("reports no change for the same set in another order", () => {
    expect(syncPermissions(["daily_book.read", "transfers.read"])).toBe(false);
    expect(getCurrentIdentity()?.permissions)
      .toEqual(["transfers.read", "daily_book.read"]);
  });

  it("keeps the rest of the identity intact", () => {
    syncPermissions([]);
    const id = getCurrentIdentity();
    expect(id?.user_id).toBe(7);
    expect(id?.role).toBe("employee");
    expect(id?.permissions).toEqual([]);
  });

  it("does nothing with no cached identity", () => {
    window.localStorage.clear();
    expect(syncPermissions(["transfers.read"])).toBe(false);
    expect(getCurrentIdentity()).toBeNull();
  });
});
