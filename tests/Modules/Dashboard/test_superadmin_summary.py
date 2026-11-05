"""HTTP integration tests for ``/api/v2/dashboard/summary``
(superadmin payload).

Since the payload slim-down the superadmin answer is exactly the ten
figures Platform → Controls shows (``platform_summary``). It used to
carry the whole platform context, including every store row with
every column (Stripe ids, contact details), on every page load.

The user reported the Platform Controls page showing "—" for
Active / Paid / Inactive / MRR. Root cause: the SPA reads
``active_stores`` / ``paid_stores`` / ``mrr_total`` / etc. but
``superadmin_dashboard_context`` returns ``active_count`` /
``paid_count`` / ``estimated_mrr``. ``_superadmin_summary`` now
adapts the legacy keys to the SPA-facing shape; this file pins
the contract so the next refactor doesn't regress.
"""
from tests._app import db, db_session
from api.Core.Clock import utc_now


def _login_superadmin(client):
    from tests.conftest import login_superadmin
    return login_superadmin(client)


def test_summary_requires_jwt(client):
    resp = client.get("/api/v2/dashboard/summary")
    assert resp.status_code == 401


def test_summary_returns_superadmin_shape(client):
    """Superadmin payload carries ``role="superadmin"`` plus the
    KPI scalars the Platform Controls page reads."""
    token = _login_superadmin(client)
    resp = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["role"] == "superadmin"


def test_summary_exposes_spa_facing_store_counts(client):
    """The KPI tiles read ``active_stores`` etc. — without the
    adapter they'd render as "—" forever even with stores in DB."""
    token = _login_superadmin(client)
    body = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    for key in (
        "active_stores", "trial_stores", "paid_stores",
        "inactive_stores", "total_stores",
    ):
        assert key in body, (
            f"Missing {key!r} on superadmin /dashboard/summary "
            f"response. SPA's Platform Controls reads it and "
            f"renders '—' without it. body keys = {list(body)}"
        )
        assert isinstance(body[key], int), body[key]


def test_summary_counts_a_seeded_active_store(client):
    """End-to-end: seed an extra active store and confirm
    ``active_stores`` increments. Validates that the adapter
    actually surfaces the live count instead of a stale snapshot."""
    from api.Modules.Tenancy.Models import Store
    token = _login_superadmin(client)
    baseline = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    with db_session():
        db.session.add(Store(
            name="Active Pro Test", slug="active-pro-test",
            email="apt@example.com", plan="pro",
            is_active=True,
        ))
        db.session.commit()
    after = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    assert after["active_stores"] == baseline["active_stores"] + 1


def test_summary_exposes_spa_facing_money_keys(client):
    """``mrr_total`` and ``arr_total`` back the MRR + ARR KPI tiles."""
    token = _login_superadmin(client)
    body = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    assert "mrr_total" in body
    assert "arr_total" in body
    # ARR is MRR × 12 (annualised). Allow a tiny float epsilon.
    if isinstance(body["mrr_total"], (int, float)):
        assert abs(body["arr_total"] - body["mrr_total"] * 12) < 0.01


def test_summary_exposes_retention_queue_and_cancellations(client):
    """``retention_queue`` (stores past cancellation, still inside
    the 180-day window) and ``cancellations_30d`` round out the
    Platform Controls overview."""
    token = _login_superadmin(client)
    body = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    assert "retention_queue" in body
    assert isinstance(body["retention_queue"], int)
    assert "cancellations_30d" in body


def test_summary_retention_queue_counts_pending_purge(client):
    """A store whose ``data_retention_until`` is in the future
    contributes to ``retention_queue``."""
    from datetime import timedelta
    from api.Modules.Tenancy.Models import Store
    token = _login_superadmin(client)
    baseline = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    with db_session():
        db.session.add(Store(
            name="Retention Pending", slug="retention-pending",
            email="rp@example.com", plan="inactive",
            data_retention_until=utc_now() + timedelta(days=90),
        ))
        db.session.commit()
    after = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    ).get_json()
    assert after["retention_queue"] == baseline["retention_queue"] + 1


# ── Slim shape (platform_summary) ─────────────────────────────

_SLIM_KEYS = {
    "role", "total_stores", "active_stores", "trial_stores",
    "paid_stores", "inactive_stores", "mrr_total", "arr_total",
    "new_stores_30d", "cancellations_30d", "retention_queue",
}


def _summary(client, token):
    resp = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.get_json()


def _seed_mixed_stores():
    """One store in every bucket the tiles count, plus a recent
    cancellation and one inside the retention window."""
    from datetime import timedelta
    from api.Modules.Tenancy.Models import Store
    now = utc_now()
    rows = [
        ("slim-bm", "basic", "monthly", True, None, None),
        ("slim-by", "basic", "yearly", True, None, None),
        ("slim-pm", "pro", "monthly", True, None, None),
        ("slim-py", "pro", "yearly", True, None, None),
        ("slim-tr", "trial", "", True, None, None),
        ("slim-in", "inactive", "", False,
         now - timedelta(days=5), now + timedelta(days=170)),
        ("slim-old", "inactive", "", False,
         now - timedelta(days=200), now - timedelta(days=20)),
    ]
    with db_session():
        for slug, plan, cycle, active, canceled, retain in rows:
            db.session.add(Store(
                name=slug, slug=slug, email=f"{slug}@example.com",
                plan=plan, billing_cycle=cycle, is_active=active,
                canceled_at=canceled, data_retention_until=retain,
                stripe_customer_id=f"cus_{slug}",
            ))
        db.session.commit()


def test_summary_is_exactly_the_ten_tiles(client):
    """The answer carries the ten figures and nothing else — no
    store list, no chart series, no legacy ``*_count`` twins."""
    _seed_mixed_stores()
    body = _summary(client, _login_superadmin(client))
    assert set(body) == _SLIM_KEYS
    assert body["role"] == "superadmin"
    for key in _SLIM_KEYS - {"role", "arr_total"}:
        assert isinstance(body[key], int), (key, body[key])
    assert isinstance(body["arr_total"], float)


def test_summary_sends_no_store_rows(client):
    """Per-store detail (names, emails, Stripe ids) never leaves in
    this answer, however many stores exist."""
    _seed_mixed_stores()
    resp = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {_login_superadmin(client)}"},
    )
    raw = resp.text
    assert "cus_slim" not in raw
    assert "slim-bm" not in raw
    assert "example.com" not in raw
    assert len(raw) < 1024, len(raw)


def test_summary_figures_match_the_full_platform_dashboard(client):
    """The tiles read the same numbers the full context counts, so
    slimming the answer changed nothing the superadmin sees."""
    from api.Modules.Superadmin.Services import (
        superadmin_dashboard_context,
    )
    _seed_mixed_stores()
    body = _summary(client, _login_superadmin(client))
    with db_session():
        ctx = superadmin_dashboard_context(db.session)
    assert body["total_stores"] == ctx["total_stores"]
    assert body["active_stores"] == ctx["active_count"]
    assert body["trial_stores"] == ctx["trial_count"]
    assert body["paid_stores"] == ctx["paid_count"]
    assert body["inactive_stores"] == ctx["inactive_count"]
    assert body["mrr_total"] == ctx["estimated_mrr"]
    assert body["arr_total"] == ctx["estimated_mrr"] * 12.0
    assert body["new_stores_30d"] == ctx["new_stores_30d"]
    assert body["cancellations_30d"] == ctx["churn_30d"]


def test_summary_counts_each_bucket(client):
    """Absolute counts over a known set of stores."""
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.query(Store).filter(
            ~Store.slug.like("slim-%"),
        ).update({Store.plan: "trial", Store.billing_cycle: "",
                  Store.canceled_at: None,
                  Store.data_retention_until: None},
                 synchronize_session=False)
        db.session.commit()
        baseline_trial = db.session.query(Store).count()
    _seed_mixed_stores()
    body = _summary(client, _login_superadmin(client))
    assert body["paid_stores"] == 4
    assert body["trial_stores"] == baseline_trial + 1
    assert body["inactive_stores"] == 2
    assert body["cancellations_30d"] == 1
    assert body["retention_queue"] == 1
    assert body["new_stores_30d"] >= 7


def test_admin_gets_the_store_dashboard_not_platform_figures(
    client, test_store_id,
):
    """Deny: a store Admin's summary is their own store's shape,
    never the platform figures."""
    from tests.conftest import login_admin
    body = _summary(client, login_admin(client, test_store_id))
    assert body["role"] == "admin"
    assert not (_SLIM_KEYS - {"role"}) & set(body)


def test_employee_gets_the_store_dashboard_not_platform_figures(
    test_store_id,
):
    """Deny: an employee sees only their store's today."""
    from tests.conftest import make_employee_client
    c, jwt = make_employee_client(test_store_id)
    body = _summary(c, jwt)
    assert body["role"] == "employee"
    assert not (_SLIM_KEYS - {"role"}) & set(body)


def test_owner_is_refused_the_summary(client):
    """Deny: an owner has no store on the token and no platform
    access; the route answers 400 and leaks no figures."""
    from api.Modules.Tenancy.Models import User
    from tests.conftest import login_owner
    with db_session():
        u = User(username="slim-owner", full_name="Owner",
                 role="owner", store_id=None)
        u.set_password("ownerpass123")
        db.session.add(u)
        db.session.commit()
    resp = client.get(
        "/api/v2/dashboard/summary",
        headers={"Authorization": f"Bearer {login_owner(client, 'slim-owner')}"},
    )
    assert resp.status_code == 400
    assert "total_stores" not in resp.text
