"""Contracts every platform-control route must keep, checked by
walking the live router instead of by remembering to add a test
per route. A new superadmin endpoint that forgets the role gate,
takes an untyped body, or skips the audit row fails here before it
ships.

Covers the ``/superadmin`` and ``/feature-flags`` routers (the
superadmin-only surfaces) — ``/tickets`` has its own
``test_audit_coverage``.
"""
import inspect
import re

import pytest
from fastapi.routing import APIRoute

from tests.conftest import login_admin, login_superadmin

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
PREFIXES = ("/superadmin", "/feature-flags")

# Routes whose gate is something other than "role == superadmin":
#   impersonate/stop runs on the CUSTOMER's token and answers 400
#   when that token carries no impersonation claim.
GATE_EXCEPTIONS = {"/superadmin/impersonate/stop": {400}}

# Every way a platform mutation records its audit row. A route must
# call one of these (or delegate to a helper that does).
AUDIT_MARKERS = (
    "_audit_and_commit(", "_audit_store(", "_audit(", "audit_superadmin(",
    "record_superadmin_action(", "apply_matrix_update(", "apply_matrix_reset(",
    "issue_store_credit(",
)


def _platform_routes():
    from api.main import api_app
    out = []
    for r in api_app.routes:
        if not isinstance(r, APIRoute):
            continue
        if not r.path.startswith(PREFIXES):
            continue
        for m in r.methods or ():
            out.append((m, r))
    return out


def _mutating_routes():
    return [(m, r) for m, r in _platform_routes() if m in MUTATING]


def _concrete_path(path: str) -> str:
    """Fill path params with values that parse: ints get 1, the
    rest a short slug."""
    def sub(match):
        name = match.group(1)
        return "1" if name.endswith("_id") or name == "id" else "x"
    return re.sub(r"\{(\w+)(?::[^}]*)?\}", sub, path)


@pytest.fixture(scope="module")
def mutating():
    rows = _mutating_routes()
    assert len(rows) > 20, "router walk found suspiciously few routes"
    return rows


class TestRoleGate:
    def test_anonymous_is_refused_everywhere(self, client, mutating):
        for method, route in mutating:
            resp = client._request(method, "/api/v2" + _concrete_path(route.path), json={})
            assert resp.status_code == 401, (method, route.path, resp.status_code)

    def test_a_store_admin_is_refused_everywhere(self, client, mutating, test_store_id):
        token = login_admin(client, test_store_id)
        headers = {"Authorization": f"Bearer {token}"}
        for method, route in mutating:
            allowed = set(GATE_EXCEPTIONS.get(route.path, {403}))
            if route.dependant.body_params:
                # FastAPI validates the body before the endpoint runs
                # its role check, so a model with required fields
                # answers 422 to the empty probe body. That still
                # proves nothing was written; a gate-less route with
                # an all-optional model would reach the handler and
                # answer 200 here.
                allowed.add(422)
            resp = client._request(
                method, "/api/v2" + _concrete_path(route.path),
                headers=headers, json={},
            )
            assert resp.status_code in allowed, (method, route.path, resp.status_code)

    def test_reads_are_superadmin_only_too(self, client, test_store_id):
        token = login_admin(client, test_store_id)
        headers = {"Authorization": f"Bearer {token}"}
        for method, route in _platform_routes():
            if method != "GET":
                continue
            resp = client.get("/api/v2" + _concrete_path(route.path), headers=headers)
            assert resp.status_code == 403, (route.path, resp.status_code)


class TestBodies:
    def test_no_mutating_route_takes_an_untyped_dict_body(self, mutating):
        offenders = []
        for method, route in mutating:
            for p in route.dependant.body_params:
                ann = p.field_info.annotation
                origin = getattr(ann, "__origin__", ann)
                if origin is dict:
                    offenders.append(f"{method} {route.path}: {p.name}")
        assert offenders == [], (
            "untyped dict bodies accept anything and validate nothing; "
            "give these a Pydantic request model: " + ", ".join(offenders)
        )

    def test_unknown_fields_are_refused(self, client, mutating):
        """Every typed body is ``extra="forbid"`` so a misspelled
        field is a 422 instead of a silently ignored request."""
        token = login_superadmin(client)
        headers = {"Authorization": f"Bearer {token}"}
        checked = 0
        for method, route in mutating:
            if not route.dependant.body_params:
                continue
            if route.path in GATE_EXCEPTIONS:
                continue
            resp = client._request(
                method, "/api/v2" + _concrete_path(route.path),
                headers=headers, json={"definitely_not_a_field": 1},
            )
            assert resp.status_code == 422, (method, route.path, resp.status_code)
            checked += 1
        assert checked > 5


class TestAudit:
    def test_every_mutating_route_records_an_audit_row(self, mutating):
        missing = []
        for method, route in mutating:
            src = inspect.getsource(route.endpoint)
            if not any(marker in src for marker in AUDIT_MARKERS):
                missing.append(f"{method} {route.path}")
        assert missing == [], (
            "CLAUDE.md invariant #7: every superadmin mutation records an "
            "audit row — " + ", ".join(missing)
        )
