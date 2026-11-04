import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLanguage } from "./index";
import ForgotPassword from "../routes/ForgotPassword";
import ResetPassword from "../routes/ResetPassword";
import LoginStore from "../routes/LoginStore";
import { UserMenu } from "../components/UserMenu";
import { FormActions, Loading, Pager, ConfirmDialog } from "../components/ui";
import { englishLeftovers } from "../test/i18n";

// Covered screens in Spanish (UI-STANDARDS §10): each one renders
// with no English words of its area left, and still works.

const forgotPassword = vi.fn();
const resetPassword = vi.fn();
const lookupStoreBySlug = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    forgotPassword: (...a: unknown[]) => forgotPassword(...a),
    resetPassword: (...a: unknown[]) => resetPassword(...a),
    lookupStoreBySlug: (s: string) => lookupStoreBySlug(s),
  };
});

beforeEach(() => {
  forgotPassword.mockReset().mockResolvedValue({ status: "ok" });
  resetPassword.mockReset().mockResolvedValue({ status: "ok" });
  lookupStoreBySlug.mockReset();
  setLanguage("es");
});

describe("in Spanish", () => {
  it("forgot password: form and the sent screen", async () => {
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    expect(screen.getByText("¿Olvidó su contraseña?")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["forgot.", "login."])).toEqual([]);
    await userEvent.type(screen.getByLabelText("Correo electrónico"), "a@b.co");
    await userEvent.click(screen.getByRole("button", { name: "Enviar enlace" }));
    expect(await screen.findByText("Revise su correo")).toBeInTheDocument();
    expect(screen.getByText("a@b.co")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["forgot.", "login."])).toEqual([]);
  });

  it("reset password: checks in Spanish before sending anything", async () => {
    render(
      <MemoryRouter initialEntries={["/reset-password?token=abc"]}>
        <Routes><Route path="/reset-password" element={<ResetPassword />} /></Routes>
      </MemoryRouter>,
    );
    expect(englishLeftovers(document.body, ["reset.", "login."])).toEqual([]);
    await userEvent.type(screen.getByLabelText("Contraseña nueva"), "abcdefgh");
    await userEvent.type(screen.getByLabelText("Confirmar contraseña nueva"), "abcdefgX");
    await userEvent.click(screen.getByRole("button", { name: "Actualizar contraseña" }));
    expect(screen.getByText("Las contraseñas no coinciden.")).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("reset password: missing link", () => {
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <Routes><Route path="/reset-password" element={<ResetPassword />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Falta el enlace de restablecimiento")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["reset.", "login."])).toEqual([]);
  });

  it("store sign-in: unknown store and the form", async () => {
    lookupStoreBySlug.mockResolvedValueOnce(null);
    const { unmount } = render(
      <MemoryRouter initialEntries={["/login/x"]}>
        <Routes><Route path="/login/:slug" element={<LoginStore />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Tienda no encontrada")).toBeInTheDocument();
    unmount();
    lookupStoreBySlug.mockResolvedValueOnce({ store_id: 3, name: "Lamar" });
    render(
      <MemoryRouter initialEntries={["/login/lamar"]}>
        <Routes><Route path="/login/:slug" element={<LoginStore />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Inicio de sesión de empleados")).toBeInTheDocument();
    expect(screen.getByText("SEGURO · LAMAR")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["login."])).toEqual([]);
  });

  it("user menu", async () => {
    render(
      <MemoryRouter>
        <UserMenu identity={{ username: "ana", role: "admin" } as never} onSignOut={() => {}} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Menú de usuario de ana" }));
    expect(screen.getByText("Perfil")).toBeInTheDocument();
    expect(screen.getByText("Cerrar sesión")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["shell."])).toEqual([]);
  });

  it("kit pieces: loading, pager, confirm, unsaved pill", () => {
    render(
      <>
        <Loading />
        <Pager page={2} totalPages={3} onPage={() => {}} total={60} pageRows={25}
          perPage={25} onPerPage={() => {}} />
        <FormActions guard={{ dirty: true } as never}><span /></FormActions>
        <ConfirmDialog open title="¿Seguro?" message="x" onConfirm={() => {}} onCancel={() => {}} />
      </>,
    );
    expect(screen.getByText("Cargando…")).toBeInTheDocument();
    expect(screen.getByText("Mostrando 26–50 de 60")).toBeInTheDocument();
    expect(screen.getByText("Siguiente →")).toBeInTheDocument();
    expect(screen.getByText("Cambios sin guardar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["common.", "pager.", "unsaved."])).toEqual([]);
  });
});
