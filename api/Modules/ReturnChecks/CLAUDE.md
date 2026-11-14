# ReturnChecks — returned customer checks (back office)

> Loaded automatically when Claude reads a file in this folder. The
> SPA side is `frontend/src/routes/ReturnChecks.tsx` and its siblings
> (`ReturnCheckForm`, `ReturnCheckBatches`, `ReturnCheckBatch`,
> `ReturnCheckBatchForm`, `ReturnCheckParties`).

## Money rules (unchanged by batches)
- A check is `pending` until paybacks reach face + fee (auto
  `recovered`) or a person marks it `loss` / `fraud`. Only the status
  date (`status_changed_on`) moves money into a month's P&L; the
  returned date (`bounced_on`) never does.
- Every payback is a `ReturnCheckPayment` mirrored by a
  `DailyLineItem(kind='return_payback')` on its day; a locked day
  refuses it (`_refuse_locked_day`). Paybacks go through "Record
  return" only.

## Batches (`msb_return_check_batch`)
- A batch is the checks the bank sent back together (one return
  notice): `returned_on`, the bank `reference`, notes. It holds no
  money; its totals come from its checks (`Services/batches.py`
  `batch_totals`).
- A check in a batch is dated by the batch: `bounced_on` follows
  `returned_on` on create, on move into a batch, and when the batch's
  date is edited. Nothing else changes when a batch changes.
- A batch with checks is never deleted (checks are never deleted);
  only an empty one, with a confirm in the SPA.
- `batch_id`, `routing_number`, `account_number` on the write body are
  applied **only when sent** (`UNSET` in `Services/__init__.py`), so a
  page that predates batches cannot clear them.

## Tracking by company / customer
- `parties.py` `party_key` is the ONE rule that two typed names are the
  same party (case, accents, punctuation, spaces ignored; nothing
  fuzzy). The By company / By customer lists (`Services/tracking.py`),
  the list's `?company=` / `?customer=` filters and the form's name
  suggestions all use it, so a tracking row opens exactly the checks
  it counted. Worked out live; nothing is stored.

## Link to check cashing (planned, NOT wired)
The check cashing app (`api/Modules/CheckCashing/`, flag `check_desk`)
stays standalone until the owner switches the link on. The intended
shape, so the data model already fits:
1. When a manager marks a cashed check bad (`BadCheck`, reason `nsf` /
   closed / stop / fraud), the CheckCashing service calls ONE function
   here (e.g. `create_from_bad_check`) inside the same transaction.
2. It creates a `ReturnCheck` with: customer = `CheckCustomer.full_name`,
   company = `CheckCompany.name`, `routing_number` / `account_number`
   from the company, check number, amount, the bad check's fee as
   `return_check_fee`, `bounced_on` = `BadCheck.returned_on`, and puts
   it in that day's batch (find-or-create by store + date).
3. A new nullable `bad_check_id` column (unique) links the two so the
   same bad check never creates two returned checks, and paybacks are
   recorded once (which side owns paybacks is the owner's call then).
