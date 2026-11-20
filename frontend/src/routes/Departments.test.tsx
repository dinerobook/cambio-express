import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Departments from "./Departments";
import { renderRoute } from "../test/renderRoute";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Account → Departments: the department setup on its own page, titled
// like its sidebar link, with the trail from the sidebar. The table
// and form are DepartmentsManager's (tested there).

vi.mock("../api/dayclose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/dayclose")>()),
  useDepartments: () => ({
    data: {
      departments: [{
        id: 1, name: "BEER", parent_id: null, parent_name: "", sort_order: 0,
        is_active: true, department_type: "merchandise", is_taxable: true, tax_rate: null,
        min_age: 21, nacs_code: "481", pos_codes: ["4"],
      }],
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  }),
}));

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
});

describe("Departments page", () => {
  it("is titled like its sidebar link and lists the setup", () => {
    renderRoute(<Departments />, { path: "/account/departments" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Departments/);
    expect(screen.getByText(/the way your register has them/)).toBeInTheDocument();
    expect(screen.getByText("BEER")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add department" })).toBeInTheDocument();
  });

  it("reads in Spanish", () => {
    setLanguage("es");
    renderRoute(<Departments />, { path: "/account/departments" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Departamentos/);
    expect(englishLeftovers(document.body, ["dept."])).toEqual([]);
  });
});
