# DineroBook Check Desk (Windows)

The check cashing app in its own window, with the MagTek Excella
scanner. Owner's direction (2026-11-10/11): the scanner is the default,
like the counter programs cashiers know — the window opens on Cash a
check, Enter gets the scanner ready, and the moment a check goes in its
MICR line and pictures fill the page. Without the scanner the cashier
types the MICR line.

It is a thin window: every check, customer and picture is saved on
dinerobook.com the moment it is entered, so the back office and phones
see it live. Nothing is kept on the PC except the window's sign-in and
the computer's check cashing activation (its browser data).

## Parts

| Folder | What |
|---|---|
| `CheckDesk/` | The window (WinForms + Microsoft Edge WebView2) and the Excella through MagTek's `MTXMLMCR.dll`. 32-bit, because that library is. |
| `CheckDesk.Core/` | What the window does, without the window: the page's scanner messages (`ScannerBridge`), which addresses the window may open (`NavigationPolicy`), `settings.json`, a demo scanner. |
| `CheckDesk.Tests/` | xUnit tests for `CheckDesk.Core`. |

The page side is `frontend/src/lib/scanner.ts` and
`frontend/src/components/CheckScanBar.tsx`; the message contract is in
`api/Modules/CheckCashing/INVARIANTS.md` ("Scanner").

## Build

`.github/workflows/check-desk.yml` tests and publishes one
`DineroBookCheckDesk.exe` on every change here; download it from the
run's page (Artifacts). By hand on Windows with the .NET 8 SDK:

```powershell
dotnet test desktop/windows/CheckDesk.Tests/CheckDesk.Tests.csproj
dotnet publish desktop/windows/CheckDesk/CheckDesk.csproj -c Release -r win-x86 --self-contained true -p:PublishSingleFile=true -o publish
```

## On the store PC

1. The Excella's USB driver and `MTXMLMCR.dll` (MagTek's API/demo
   installer; already there when another check program uses the
   scanner). Only one program can hold the scanner: close the old one.
2. The Microsoft Edge WebView2 Runtime (built into Windows 11 and
   current Windows 10).
3. Run `DineroBookCheckDesk.exe`, sign in, and an Admin activates this
   computer for check cashing (Check cashing → Settings).

Optional `%LOCALAPPDATA%\DineroBook\CheckDesk\settings.json`:

```json
{ "home": "https://dinerobook.com/app/check-cashing", "docFeed": "MANUAL", "demoScanner": false }
```

`docFeed` is `MANUAL` (one check in the slot) or `AUTOFEED`;
`demoScanner` (or `--demo-scanner`) pretends to read a sample check, to
try the window without a scanner. `home` must be https (or a local test
server).

## Not yet

- Signed installer and the Microsoft Store (MSIX) — until then Windows
  SmartScreen warns on first run ("More info" → "Run anyway").
- Scanning ID cards, and the phone as a backup scanner (QR code).
