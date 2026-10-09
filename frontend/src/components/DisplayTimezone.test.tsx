import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { DisplayTimezone } from "./DisplayTimezone";
import { formatTime, getDisplayTimezone, setDisplayTimezone } from "../lib/datetime";

// The shell points every date/time helper at the store's zone
// (session-status `timezone`) for the page below it.

const LOCKED_AT = "2026-10-09T15:00:00"; // 10:00 AM in Chicago

function Stamp() {
  // A page that keeps local state across the parent's re-renders.
  const [mountedAt] = useState(() => formatTime(LOCKED_AT));
  return <p>{mountedAt}</p>;
}

describe("<DisplayTimezone>", () => {
  it("renders the page on the store's clock from the first paint", () => {
    render(
      <DisplayTimezone timezone="America/Chicago"><Stamp /></DisplayTimezone>,
    );
    expect(screen.getByText("10:00 AM")).toBeInTheDocument();
    expect(getDisplayTimezone()).toBe("America/Chicago");
  });

  it("re-renders the page when the store's zone changes", () => {
    const { rerender } = render(
      <DisplayTimezone timezone="America/Chicago"><Stamp /></DisplayTimezone>,
    );
    rerender(
      <DisplayTimezone timezone="America/Los_Angeles"><Stamp /></DisplayTimezone>,
    );
    // The page re-mounted, so even its mount-time state is current.
    expect(screen.getByText("8:00 AM")).toBeInTheDocument();
  });

  it("keeps the last known zone while session-status is loading", () => {
    setDisplayTimezone("America/New_York");
    render(<DisplayTimezone timezone={undefined}><Stamp /></DisplayTimezone>);
    expect(screen.getByText("11:00 AM")).toBeInTheDocument();
  });

  it("falls back to the device's zone when the store has none", () => {
    setDisplayTimezone("America/Chicago");
    render(<DisplayTimezone timezone=""><Stamp /></DisplayTimezone>);
    expect(getDisplayTimezone()).toBeUndefined();
    expect(screen.getByText(formatTime(LOCKED_AT))).toBeInTheDocument();
  });
});
