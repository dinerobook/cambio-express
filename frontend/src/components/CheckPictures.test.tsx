import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PictureSlot, PictureView } from "./CheckPictures";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";

// The shared picture slot of the check cashing app
// (api/Modules/CheckCashing/INVARIANTS.md "Pictures"): camera or file,
// the camera's two failures said plainly, nothing to change for
// someone who may only look, a picture that failed to load says so.

const api = vi.hoisted(() => ({ useCheckPictureBlob: vi.fn() }));
vi.mock("../api/checkCashing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/checkCashing")>()),
  ...api,
}));

const ok = <T,>(data: T) => ({
  data, isLoading: false, isError: false, error: null, isFetching: false, refetch: vi.fn(),
});

function stubCamera(getUserMedia: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(getUserMedia) }, configurable: true,
  });
}

beforeEach(() => {
  signInAs({ permissions: ["check_cashing.read"] });
  api.useCheckPictureBlob.mockImplementation((id?: number | null) => (
    ok(id != null ? new Blob(["x"]) : undefined)
  ));
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("picture slot", () => {
  it("says when the computer has no camera", async () => {
    renderRoute(<PictureSlot label="Customer photo" pictureId={null} save={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Camera" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/No camera was found/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Take picture" })).toBeDisabled();
  });

  it("says when the browser blocks the camera", async () => {
    stubCamera(() => Promise.reject(new DOMException("no", "NotAllowedError")));
    renderRoute(<PictureSlot label="Customer photo" pictureId={null} save={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Camera" }));
    expect(await screen.findByText(/The browser is blocking the camera/)).toBeInTheDocument();
  });

  it("asks for the camera and stops it when the popup closes", async () => {
    const stop = vi.fn();
    stubCamera(() => Promise.resolve({ getTracks: () => [{ stop }] }));
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    renderRoute(<PictureSlot label="Customer photo" pictureId={null} save={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Camera" }));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false }),
    ));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("sends a chosen file as base64", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    renderRoute(<PictureSlot label="Customer photo" pictureId={null} save={save} />);
    await userEvent.upload(
      screen.getByLabelText("Picture file for Customer photo"),
      new File(["abc"], "a.png", { type: "image/png" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledWith(btoa("abc")));
  });

  it("offers nothing to change to someone who may only look", () => {
    renderRoute(
      <PictureSlot label="Customer photo" pictureId={5} save={vi.fn()} canChange={false} />,
    );
    expect(screen.getByRole("button", { name: "Show Customer photo large" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Camera" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "File" })).not.toBeInTheDocument();
  });

  it("says when a picture cannot be loaded", () => {
    api.useCheckPictureBlob.mockReturnValue({ ...ok(undefined), isError: true });
    renderRoute(<PictureView id={9} label="Front of the check" />);
    expect(screen.getByText("Couldn't load the picture")).toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    renderRoute(<PictureSlot label="Foto" pictureId={null} save={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Cámara" }));
    await screen.findByText(/No se encontró una cámara/);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});
