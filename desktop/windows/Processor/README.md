# DineroBook Processor and DineroBook Manager (Windows)

The store PC side of Gilbarco imports, replacing the Python site agent
(`agent/`) for new installs (owner, 2026-11-18). **DineroBook
Processor** is a Windows service (`DineroBookProcessor`) that sends
every file Passport writes to its BOOutbox folder to DineroBook.
**DineroBook Manager** is its window: sign in, choose the folder,
install and watch the service.

The server does all the parsing and keeps every file raw, so the
Processor needs no update when parsing improves.

## Parts

| Folder | What |
|---|---|
| `Processor/` | The service (`DineroBookProcessor.exe`): a .NET Worker Service with `UseWindowsService()`, plus `--console` for testing. |
| `Manager/` | The window (`DineroBookManager.exe`, WinForms). |
| `Processor.Core/` | Everything both do, without the service or the window: the pipeline (`ProcessorEngine`), the business-day rules (`UploadScheduler`, `BusinessDateReader`), the ledger, the upload answers, the rate pacer, the agent key on disk (DPAPI), the sign-in calls (`SignIn/`), and `ServerContract.cs`, the server values copied by hand. |
| `Processor.Tests/` | xUnit tests for `Processor.Core`. |
| `../DineroBookProcessor.sln` | Opens all four in Visual Studio. |

`tests/Modules/PosImport/test_processor_contract.py` (server side)
reads `ServerContract.cs` and fails when a limit, a path or an answer
field there no longer matches the server.

## What the Processor does

- **Sends** `PJR*.xml` (the journal) and the day-close movement
  reports `FGM`, `ISM`, `MCM`, `MSM`, `TLM`, `TPM` (`*.xml`), the same
  list as the Python agent's `agent.ini.example`. Nothing else.
- **Read only.** It never moves, renames, deletes, changes or locks a
  Passport file: it lists the folder and opens each file for reading
  with ReadWrite + Delete sharing, so Passport and the other
  back-office programs reading the same folder are never in the way.
- **A file goes once its size and time held still across two polls**
  (every 5 seconds). Empty files are never sent.
- **Several at a time.** A store with 2–4 registers writes several files
  at once, so up to 4 go together (`maxConcurrentUploads` in
  settings.json, 1–8). A slow or failing file never holds up the others
  of its day; it is retried on its own.
- **Business days in order.** The server books day D as soon as any
  file of a later business day arrives (`auto_commit_rolled_days`), and
  a file arriving after its day was booked is not added. At day close
  register 1's last sale of day D and register 2's first sale of day
  D+1 are written at the same moment, so the Processor reads each file's
  `BusinessDate` (the journal event's, or the movement report's
  `MovementHeader`, exactly as the server reads it) and:
  1. sends older business days first;
  2. sends files of the same day in parallel;
  3. sends nothing of a later day while any file of an earlier day is
     still being written, waiting, being sent or being retried. A file
     that keeps failing holds later days back, and the Status page
     names it ("Waiting on …");
  4. sends a file with no readable business day (not a journal or
     report) in file name order, with no barrier.
  The date is read with DTDs prohibited and a size cap, and checked
  again on the exact bytes about to be sent.
- **Polls; no FileSystemWatcher.** A watcher holds the folder open and
  drops events on network shares; a poll never misses a file.
- **Paced under the server's limit** (`120/minute;6000/hour`): up to 8
  uploads at once, refilled at 5,000 an hour, never more than 100 in a
  minute. A first run in a folder with years of files takes a day or
  so, a day at a time; new sales show up once it has caught up.

Each answer of `POST /api/v2/posimport/agent/upload`:

| Answer | What happens |
|---|---|
| 200 | Done: in the ledger. Logged as `staged`, `duplicate` or `parse_error` (the server keeps the file and re-reads it after a parser fix). |
| 401 | The key was refused. Stops sending, the status says "sign in again in DineroBook Manager", and it looks again every 5 minutes, at once when a new key is saved. |
| 402 / 403 | The store is closed to uploads (lapsed, frozen, disabled). Files wait; it looks again every 5 minutes. |
| 422 with a message | That file can never go (too large, no name): recorded in `skipped.txt`, never tried again. |
| 422 from the request check | The server no longer takes this version's upload format. Nothing is skipped; the status asks for an update. |
| 429 | Too many requests: everything pauses a minute. |
| 5xx, network, anything else | That file is tried again: 5 s, 15 s, 1 min, then every 5 min; the others of its day go on. Never dropped. After 3 failures of the same file it is an Error in the Event Log ("Stuck on …"). Two uploads colliding on the server come back as a 5xx too; the retry then finds the file staged (`duplicate`), which counts as sent. When every try fails (DineroBook or the network is down) it sends one file at a time on the same ladder until one goes through. |

Files over the server's 4 MB, or with names over 120 characters, are
skipped without sending (logged).

## On the store PC

Windows 10 or 11, 64-bit, on a PC that can open Passport's BOOutbox
(`C:\Passport\XMLGateway\BOOutbox` on the Passport PC, or a share such
as `\\PASSPORT\BOOutbox`).

1. **Get the two programs.** GitHub → Actions → *DineroBook Processor*
   → the latest run → Artifacts → `DineroBookProcessor`. Unzip
   `DineroBookManager.exe` and `DineroBookProcessor.exe` into one folder
   (Downloads is fine: Install copies them to
   `C:\Program Files\DineroBook\Processor\`).
2. **SmartScreen.** v1 is not signed, so Windows says "Windows
   protected your PC" the first time: **More info → Run anyway**.
3. Open **DineroBookManager.exe** and choose **Restart as
   administrator** (setup changes the computer; the Status and Log
   tabs work without it).
4. **Setup → 1. Sign in** with the store's DineroBook **admin or
   owner** login (2-step codes work). An owner with several stores is
   asked "Which store is this computer at?". The Manager gets the
   store's upload key, keeps only that key, and signs out. Logins
   without the Day close edit permission (cashiers, accountants) are
   told to ask the admin or owner; platform logins are refused.
5. **Setup → 2. Passport folder**: Browse to BOOutbox, **Check**,
   **Save settings**. Leave the DineroBook address at
   `https://dinerobook.com`.
6. **Setup → 3. Windows service**: choose the account (below) and
   **Install / Update**. It installs, starts, and starts with Windows
   from then on (delayed start; Windows restarts it if it stops).
7. **Status** shows the store, the last upload, today's count and what
   is waiting. **Test connection** checks the address and the key
   without sending a file.

### Which account the service runs as

- **Local Service** (default) when BOOutbox is a folder on this PC.
  Low privilege; it cannot open network shares.
- **A Windows account** when BOOutbox is a network share. Use one
  that can open the share in File Explorer:
  - domain: `STORE\dinerobook` with read access to the share;
  - no domain (workgroup): create the same local user with the same
    password on both PCs (`.\dinerobook`), and give it read access to
    the share on the Passport PC.

  Type the account and its password and choose **Install / Update**.
  The Manager hands the password to Windows (never on a command line)
  and does not keep it, and grants the account "Log on as a service".
  A changed Windows password needs **Install / Update** again with the
  new one. The folder check in Setup runs as you, not the service: the
  Status tab says whether the service itself can read the share.

### Moving from the Python agent

Stop the old agent first (its Task Scheduler task or NSSM service), or
both upload every file. To skip re-sending what it already sent: after
Install, **Stop** the service, copy the agent's `uploaded.txt` to
`%ProgramData%\DineroBook\Processor\state\sent.txt` (same format), and
**Start** it. Without that every old file is sent once more and comes
back `duplicate`, which is harmless but takes hours on a big folder. The old key keeps
working until revoked: revoke it in DineroBook, **Register import →
Automatic uploads**.

## Files on the PC

All under `%ProgramData%\DineroBook\Processor\`, set up by Install:

| File | What | Who may write |
|---|---|---|
| `settings.json` | Passport folder, DineroBook address, which store and key (not the key itself) | Administrators |
| `agent-key.bin` | The store's upload key, DPAPI-encrypted for this PC; readable only by SYSTEM, Administrators and the service | Administrators |
| `state\sent.txt` | Files DineroBook accepted (name, time, outcome). Safe to delete: the server keeps one copy per file name, so a resend comes back `duplicate` | the service |
| `state\skipped.txt` | Files refused for good, with why | the service |
| `state\status.json` | What the service is doing, for the Manager | the service |
| `state\logs\processor-YYYYMMDD.log` | One log a day, 14 days kept | the service |

Errors also go to the Windows Event Log (Application, source
"DineroBook Processor"). No password and no sign-in token is ever kept,
and the key never appears in a log, the status or a message. The
Processor opens no network port.

**Sign in again** issues a new key and revokes the old one. **Uninstall**
removes the service and its program file; it can also delete the saved
key (revoke it in DineroBook too). The data folder stays.

## Testing without installing

```powershell
DineroBookManager.exe --data-dir C:\temp\proc-test
DineroBookProcessor.exe --console --data-dir C:\temp\proc-test
```

`--data-dir` uses a test folder instead of ProgramData: sign-in and
settings work without administrator rights, and the key file there
also admits the person who ran the Manager, so the `--console`
Processor started by the same person can read it. Point the address at
a test server on this computer (`http://localhost:<port>`; plain http
is accepted only for localhost). Never test with a real store's login.

## Build

`.github/workflows/dinerobook-processor.yml` builds with warnings as
errors, runs the tests and publishes both .exe files on every change
here. By hand on Windows with the .NET 8 SDK:

```powershell
dotnet test desktop/windows/Processor.Tests/Processor.Tests.csproj
dotnet publish desktop/windows/Processor/Processor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o publish
dotnet publish desktop/windows/Manager/Manager.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o publish
```

## Rules for changes

- Passport's files are read only: list, open shared, read, close.
- Never drop a file; the only "never again" is a 422 with a message from
  the route itself.
- Never send a file of a later business day while one of an earlier day
  is still on its way (`UploadScheduler`); the business day is read the
  way the server reads it (`BusinessDateReader`, whose event kinds the
  contract test compares with the server's).
- A server value used here goes in `ServerContract.cs` and its check in
  `test_processor_contract.py`.
- The key never reaches a log, the status, a message or a generated
  `ToString` (the classes holding secrets are not records for that
  reason). The Manager keeps nothing from a sign-in but the key.
- Setup that changes the machine (key, settings, service) needs
  administrator rights; viewing does not.

## Not yet

- A signed installer (SmartScreen warns until then), automatic updates,
  32-bit and ARM builds.
- A proxy setting: the service follows its own account's Windows proxy
  setting, which for Local Service means a direct connection.
