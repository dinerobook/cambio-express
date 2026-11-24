"""Journal-entry export (P1-8 phase A) + the transfers-dump fix.

The invariants under test:
  * every journal entry balances (debits == credits) including
    the over/short line absorbing tender-vs-sales variance,
  * department credits use the store's own department names and
    the unclassified remainder is booked separately,
  * empty ``store_ids`` resolves to the caller's own store (the
    Data Export page's contract — previously a 422/404),
  * the `transfers` CSV slug exists (previously 404 in prod).
"""
import csv
import io

from tests.conftest import login_admin


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _book_close(client, h, day, **overrides):
    body = {
        "register_label": "Register 1",
        "gross_sales": 1000.0, "sales_tax": 80.0,
        "cash_total": 400.0, "card_total": 650.0, "other_total": 0.0,
    }
    body.update(overrides)
    resp = client.post(
        f"/api/v2/dayclose/day/{day}/closes", headers=h, json=body,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _rows(text):
    return list(csv.reader(io.StringIO(text)))


def test_journal_csv_balances_with_departments(client, test_store_id):
    h = _headers(login_admin(client, test_store_id))
    dept = client.post(
        "/api/v2/dayclose/departments", headers=h,
        json={"name": "Grocery"},
    ).json()["department"]
    _book_close(
        client, h, "2026-08-20",
        department_sales=[{"department_id": dept["id"], "amount": 700.0}],
    )
    # Second day with a tender variance: tenders 1030 vs 1080 due.
    _book_close(
        client, h, "2026-08-21",
        register_label="Register 2", card_total=600.0,
    )

    resp = client.get(
        "/api/v2/reports/journal-entries.csv"
        "?from=2026-08-19&to=2026-08-22&store_ids=",
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    rows = _rows(resp.text)
    assert rows[0] == ["Date", "Account", "Debit", "Credit", "Memo"]

    body = [r for r in rows[1:] if r and r[0] not in ("", "TOTAL")]
    debits = round(sum(float(r[2] or 0) for r in body), 2)
    credits = round(sum(float(r[3] or 0) for r in body), 2)
    assert debits == credits            # every entry balances

    accounts_d20 = {r[1] for r in body if r[0] == "2026-08-20"}
    assert "Sales — Grocery" in accounts_d20
    assert "Sales — unclassified" in accounts_d20   # 1000 − 700
    assert "Sales tax payable" in accounts_d20

    # Day 2 tenders 400 + 600 = 1000 against 1080 due (gross +
    # tax): the $80 shortfall lands on the over/short debit side.
    os_rows = [
        r for r in body
        if r[0] == "2026-08-21" and r[1] == "Cash over/short"
    ]
    assert len(os_rows) == 1
    assert float(os_rows[0][2]) == 80.0             # debit side

    total = next(r for r in rows if r and r[0] == "TOTAL")
    assert total[2] == total[3]                     # totals row balances


def test_a_paid_out_department_is_a_debit_under_its_own_name(
    client, test_store_id,
):
    """Lottery cashed is a minus department line. It leaves on its own
    account as a debit, never as a negative "Sales — unclassified":
    the departments already add up to the day's sales."""
    h = _headers(login_admin(client, test_store_id))

    def dept(name):
        return client.post(
            "/api/v2/dayclose/departments", headers=h, json={"name": name},
        ).json()["department"]["id"]

    _book_close(
        client, h, "2026-08-20",
        gross_sales=650.0, sales_tax=0.0,
        cash_total=650.0, card_total=0.0, other_total=0.0,
        department_sales=[
            {"department_id": dept("Grocery"), "amount": 700.0},
            {"department_id": dept("Lottery (Cashed)"), "amount": -50.0},
        ],
    )
    resp = client.get(
        "/api/v2/reports/journal-entries.csv"
        "?from=2026-08-20&to=2026-08-20&store_ids=",
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    body = [
        r for r in _rows(resp.text)[1:] if r and r[0] not in ("", "TOTAL")
    ]
    lines = {r[1]: (float(r[2] or 0), float(r[3] or 0)) for r in body}
    assert lines == {
        "Cash on hand": (650.0, 0.0),
        "Sales — Grocery": (0.0, 700.0),
        "Sales — Lottery (Cashed)": (50.0, 0.0),
    }
    assert sum(d for d, _ in lines.values()) == sum(c for _, c in lines.values())


def test_transfers_slug_exists_and_empty_scope_resolves(
    client, test_store_id,
):
    h = _headers(login_admin(client, test_store_id))
    resp = client.get(
        "/api/v2/reports/transfers.csv"
        "?from=2026-08-01&to=2026-08-23&store_ids=",
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    rows = _rows(resp.text)
    assert rows[0][0] == "Date"
    assert rows[0][6] == "Send Amount"
