"""HTTP integration tests for the Admin tax-export endpoints.

  GET /api/v2/admin/tax-export/years  → picker dropdown payload
  GET /api/v2/admin/tax-export.zip    → year-end packet ZIP

The matching React page (frontend/src/routes/AdminTaxExport.tsx)
calls both endpoints — the year picker on mount, the ZIP on the
download button.
"""
from datetime import date
from tests._app import db, db_session


def _login(client_, store_id):
    resp = client_.post(
        "/api/v2/auth/login",
        json={
            "username": "admin@test.com",
            "password": "testpass123!",
            "store_id": store_id,
        },
    )
    return resp.get_json()["access_token"]


# ── auth gating ─────────────────────────────────────────────


def test_years_requires_jwt(client):
    resp = client.get("/api/v2/admin/tax-export/years")
    assert resp.status_code == 401


def test_years_rejects_superadmin(client):
    """Superadmin JWT carries no store scope — the year query
    needs a store_id, so it 403s."""
    from tests.conftest import login_superadmin
    token = login_superadmin(client)
    resp = client.get(
        "/api/v2/admin/tax-export/years",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


# ── happy path ──────────────────────────────────────────────


def test_years_seeds_this_and_last_for_brand_new_store(
    client, test_store_id,
):
    """A store with no transfers + no daily reports still gets
    the current and previous years on the list — otherwise the
    picker would render empty on day one."""
    token = _login(client, test_store_id)
    resp = client.get(
        "/api/v2/admin/tax-export/years",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    today = date.today()
    assert today.year in body["years"]
    assert (today.year - 1) in body["years"]
    # Newest first — the SPA's <select> renders in this order.
    assert body["years"] == sorted(body["years"], reverse=True)
    # Default selection is last calendar year (the typical use
    # case is "do my taxes in February for last year").
    assert body["default_year"] == today.year - 1


def test_years_includes_year_from_existing_transfer(
    client, test_store_id,
):
    """A store with a transfer dated 2022-03-01 must see 2022 in
    the picker even though it's older than this/last year."""
    from api.Modules.Transfers.Models import Transfer
    from tests._app import db
    with db_session():
        # `total_collected` is a derived property (send + fee +
        # federal_tax — see CLAUDE.md invariant #9), not a column,
        # so we don't pass it.
        t = Transfer(
            store_id=test_store_id,
            customer_id=None,
            company="Intermex",
            send_date=date(2022, 3, 1),
            send_amount=100, fee=5, federal_tax=0,
            sender_name="Old Sender",
            recipient_name="Old Recipient",
            country="MX",
        )
        db.session.add(t); db.session.commit()
    token = _login(client, test_store_id)
    body = client.get(
        "/api/v2/admin/tax-export/years",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    assert 2022 in body["years"]


def test_years_includes_year_from_existing_daily_report(
    client, test_store_id,
):
    """A store with a closed daily report dated 2021-11-15 must
    see 2021 in the picker."""
    from api.Modules.DailyBook.Models import DailyReport
    from tests._app import db
    with db_session():
        dr = DailyReport(
            store_id=test_store_id,
            report_date=date(2021, 11, 15),
        )
        db.session.add(dr); db.session.commit()
    token = _login(client, test_store_id)
    body = client.get(
        "/api/v2/admin/tax-export/years",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    assert 2021 in body["years"]


# ── Flask redirect ──────────────────────────────────────────


def test_legacy_admin_tax_export_redirects_to_app(
    logged_in_client,
):
    """Flask /admin/tax-export 301s to /app/admin/tax-export so
    sidebar links + old bookmarks still work after the SPA
    migration."""
    resp = logged_in_client.get(
        "/admin/tax-export", follow_redirects=False,
    )
    assert resp.status_code == 301
    assert resp.headers["Location"].startswith("/app/admin/tax-export")


def test_legacy_admin_tax_export_preserves_query_string(
    logged_in_client,
):
    """If the user hits /admin/tax-export?year=2024 (e.g. an
    older email link), the redirect must carry the year through
    so the SPA pre-selects the same year."""
    resp = logged_in_client.get(
        "/admin/tax-export?year=2024", follow_redirects=False,
    )
    assert resp.status_code == 301
    assert "year=2024" in resp.headers["Location"]


# ── /tax-export.zip ─────────────────────────────────────────


def test_tax_pack_requires_jwt(client):
    resp = client.get("/api/v2/admin/tax-export.zip?year=2024")
    assert resp.status_code == 401


def test_tax_pack_returns_zip_with_expected_files(
    client, test_store_id,
):
    """Happy path — admin downloads the ZIP, gets a non-empty
    archive with each expected file."""
    import io
    import zipfile
    token = _login(client, test_store_id)
    resp = client.get(
        f"/api/v2/admin/tax-export.zip?year={date.today().year}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "application/zip"
    cd = resp.headers["Content-Disposition"]
    assert "attachment" in cd
    assert ".zip" in cd
    payload = resp.get_data()
    assert len(payload) > 0
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        names = set(zf.namelist())
        year = date.today().year
        assert f"transfers_{year}.csv" in names
        assert f"monthly_pl_{year}.csv" in names
        assert f"daily_summary_{year}.csv" in names
        assert f"customers_{year}.csv" in names
        assert "README.txt" in names


def test_tax_pack_transfers_csv_has_header_row(client, test_store_id):
    """The transfers CSV always has a header row even when there
    are zero rows for the year."""
    import io
    import zipfile
    token = _login(client, test_store_id)
    resp = client.get(
        f"/api/v2/admin/tax-export.zip?year={date.today().year}",
        headers={"Authorization": f"Bearer {token}"},
    )
    payload = resp.get_data()
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        year = date.today().year
        text = zf.read(f"transfers_{year}.csv").decode("utf-8")
    first_line = text.splitlines()[0]
    assert "Send Date" in first_line
    assert "Total Collected" in first_line


def test_tax_pack_rejects_cashier_role(client, test_store_id):
    """An employee-role JWT carries a store scope but can't
    download — same gating as /customers/export.csv."""
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(
            store_id=test_store_id, username="cashier@test.com",
            full_name="Cashier", role="employee",
        )
        u.set_password("p123pass!")
        db.session.add(u); db.session.commit()
    login = client.post(
        "/api/v2/auth/login",
        json={
            "username": "cashier@test.com", "password": "p123pass!",
            "store_id": test_store_id,
        },
    )
    token = login.get_json()["access_token"]
    resp = client.get(
        "/api/v2/admin/tax-export.zip?year=2024",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_tax_pack_rejects_invalid_year(client, test_store_id):
    """Year validation: < 2000 or > 2100 → 422 from Pydantic."""
    token = _login(client, test_store_id)
    resp = client.get(
        "/api/v2/admin/tax-export.zip?year=1999",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


# ── ZIP contents ────────────────────────────────────────────


def _zip_csv(client_, token, year, name):
    """Download the pack and return one CSV as a list of rows."""
    import csv
    import io
    import zipfile
    resp = client_.get(
        f"/api/v2/admin/tax-export.zip?year={year}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.get_data())) as zf:
        text = zf.read(f"{name}_{year}.csv").decode("utf-8")
    return list(csv.reader(io.StringIO(text)))


def test_tax_pack_transfers_csv_includes_canceled_and_year_bounds(
    client, test_store_id, test_admin_id,
):
    """Canceled rows stay in the ledger (audit trail); Jan 1 and
    Dec 31 are inside the year, the neighbouring days are not.
    Total Collected = send + fee + federal tax."""
    from tests.conftest import seed_transfer
    seed_transfer(test_store_id, test_admin_id,
                  send_date=date(2023, 12, 31), sender_name="Prev Year")
    seed_transfer(test_store_id, test_admin_id,
                  send_date=date(2024, 1, 1), sender_name="New Year",
                  send_amount=200.0, fee=4.0)
    seed_transfer(test_store_id, test_admin_id,
                  send_date=date(2024, 12, 31), sender_name="Last Day",
                  status="Canceled")
    seed_transfer(test_store_id, test_admin_id,
                  send_date=date(2025, 1, 1), sender_name="Next Year")
    token = _login(client, test_store_id)
    rows = _zip_csv(client, token, 2024, "transfers")
    header, body = rows[0], rows[1:]
    col = {name: i for i, name in enumerate(header)}
    assert [r[col["Sender Name"]] for r in body] == ["New Year", "Last Day"]
    first, last = body
    assert first[col["Send Date"]] == "2024-01-01"
    assert float(first[col["Total Collected"]]) == (
        float(first[col["Send Amount"]]) + float(first[col["Fee"]])
        + float(first[col["Federal Tax"]])
    ) == 206.0
    assert last[col["Status"]] == "Canceled"


def test_tax_pack_transfers_csv_creator_name_and_missing_user(
    client, test_store_id, test_admin_id,
):
    """Created By shows the user's name; a transfer whose creator
    is gone exports a blank, not a crash."""
    from tests.conftest import seed_transfer
    from api.Modules.Tenancy.Models import User
    from api.Modules.Transfers.Models import Transfer
    seed_transfer(test_store_id, test_admin_id,
                  send_date=date(2024, 5, 1), sender_name="Has Creator")
    gone_id = seed_transfer(test_store_id, test_admin_id,
                            send_date=date(2024, 5, 2),
                            sender_name="Orphan")
    with db_session():
        db.session.get(Transfer, gone_id).created_by = 999999
        db.session.commit()
        admin = db.session.get(User, test_admin_id)
        expected = admin.full_name or admin.username
    token = _login(client, test_store_id)
    rows = _zip_csv(client, token, 2024, "transfers")
    col = {name: i for i, name in enumerate(rows[0])}
    by_sender = {r[col["Sender Name"]]: r for r in rows[1:]}
    assert by_sender["Has Creator"][col["Created By"]] == expected
    assert by_sender["Orphan"][col["Created By"]] == ""


def test_tax_pack_empty_year_has_headers_and_twelve_month_rows(
    client, test_store_id,
):
    """A year with no data still yields well-formed CSVs: headers
    only for ledgers, 12 zeroed rows for the monthly P&L."""
    token = _login(client, test_store_id)
    assert len(_zip_csv(client, token, 2019, "transfers")) == 1
    assert len(_zip_csv(client, token, 2019, "daily_summary")) == 1
    assert len(_zip_csv(client, token, 2019, "customers")) == 1
    pl = _zip_csv(client, token, 2019, "monthly_pl")
    assert len(pl) == 13
    assert pl[1][0] == "2019-01" and pl[12][0] == "2019-12"
    assert all(float(v) == 0.0 for r in pl[1:] for v in r[1:])


def test_tax_pack_daily_summary_rows_and_locked_flag(
    client, test_store_id,
):
    from datetime import datetime
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add_all([
            DailyReport(
                store_id=test_store_id, report_date=date(2024, 3, 2),
                taxable_sales_cents=10000, locked_at=datetime(2024, 3, 3),
            ),
            DailyReport(store_id=test_store_id,
                        report_date=date(2024, 3, 1)),
            DailyReport(store_id=test_store_id,
                        report_date=date(2023, 12, 31)),
        ])
        db.session.commit()
    token = _login(client, test_store_id)
    rows = _zip_csv(client, token, 2024, "daily_summary")
    assert rows[0] == [
        "Date", "Total Receipts", "Total Disbursements",
        "Over/Short", "Locked",
    ]
    assert [r[0] for r in rows[1:]] == ["2024-03-01", "2024-03-02"]
    assert rows[1][4] == "no"
    assert rows[2][4] == "yes"
    assert float(rows[2][1]) == 100.0


def test_tax_pack_monthly_pl_reports_dollars_not_cents(
    client, test_store_id,
):
    """A $123.45 taxable-sales month must export as 123.45."""
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        db.session.add(MonthlyFinancial(
            store_id=test_store_id, year=2024, month=2,
            taxable_sales_cents=12345,
        ))
        db.session.commit()
    token = _login(client, test_store_id)
    rows = _zip_csv(client, token, 2024, "monthly_pl")
    header = rows[0]
    feb = rows[2]
    assert feb[0] == "2024-02"
    idx = [i for i, h in enumerate(header)
           if h.lower().startswith("taxable sales")][0]
    assert float(feb[idx]) == 123.45


def test_tax_pack_customers_csv_excludes_canceled_and_buckets_walkins(
    client, test_store_id, test_admin_id,
):
    from api.Modules.Customers.Models import Customer
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        c = Customer(
            store_id=test_store_id, full_name="Ana Perez",
            address="1 Main St", phone_country="+1",
            phone_number="5551234",
        )
        db.session.add(c)
        db.session.commit()
        cid = c.id

        def _t(**kw):
            base = dict(
                store_id=test_store_id, created_by=test_admin_id,
                send_date=date(2024, 6, 1), company="Intermex",
                send_amount=100, fee=5, federal_tax=1,
            )
            base.update(kw)
            db.session.add(Transfer(**base))

        _t(customer_id=cid, sender_name="Ana P.", send_amount=300)
        _t(customer_id=cid, sender_name="Ana P.", send_amount=200)
        _t(customer_id=cid, sender_name="Ana P.", send_amount=999,
           status="Canceled")
        _t(customer_id=None, sender_name="Walker", send_amount=50)
        _t(customer_id=None, sender_name="")
        db.session.commit()
    token = _login(client, test_store_id)
    rows = _zip_csv(client, token, 2024, "customers")
    assert rows[0] == [
        "Customer", "Phone", "Address", "Count", "Total Sent",
        "Total Fees",
    ]
    by_name = {r[0]: r for r in rows[1:]}
    ana = by_name["Ana Perez"]
    assert ana[1] == "+15551234"
    assert ana[2] == "1 Main St"
    assert ana[3] == "2"                       # canceled excluded
    assert float(ana[4]) == 500.0
    assert float(ana[5]) == 10.0
    assert by_name["Walker"][1:3] == ["", ""]
    assert "(walk-in)" in by_name


def test_tax_pack_is_scoped_to_callers_store(
    client, test_store_id,
):
    """Another store's transfers never leak into this store's pack."""
    from api.Modules.Tenancy.Models import Store
    from api.Modules.Transfers.Models import Transfer
    with db_session():
        other = Store(name="Other Shop", slug="other-shop")
        db.session.add(other)
        db.session.commit()
        db.session.add(Transfer(
            store_id=other.id, send_date=date(2024, 4, 1),
            company="Maxi", send_amount=10, fee=1, federal_tax=0,
            sender_name="Foreign Sender",
        ))
        db.session.commit()
    token = _login(client, test_store_id)
    assert len(_zip_csv(client, token, 2024, "transfers")) == 1
    assert len(_zip_csv(client, token, 2024, "customers")) == 1


def test_tax_pack_filename_and_readme(client, test_store_id):
    import io
    import zipfile
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = db.session.get(Store, test_store_id)
        s.slug = "a/b"
        name = s.name
        db.session.commit()
    token = _login(client, test_store_id)
    resp = client.get(
        "/api/v2/admin/tax-export.zip?year=2024",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert 'filename="a-b-tax-pack-2024.zip"' in (
        resp.headers["Content-Disposition"]
    )
    with zipfile.ZipFile(io.BytesIO(resp.get_data())) as zf:
        readme = zf.read("README.txt").decode()
    assert name in readme and "Year:   2024" in readme
