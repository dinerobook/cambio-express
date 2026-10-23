"""The response contract (``tests/_response_contract.py``) and the
ratchet that every JSON route documents its answer.

conftest runs the contract on every request the suite makes: a JSON
answer must have exactly the fields its documented model declares. A
route still building a plain dict documents its model with
``response_model=None, responses={200: {"model": X}}`` — the answer
leaves unchanged (no filtering, so nothing can be dropped from a live
page) and the contract proves the documentation is true.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

from api.main import api_app
from tests._response_contract import check, documented_model, shape_errors


class _Line(BaseModel):
    label: str
    amount: float


class _Answer(BaseModel):
    total: int
    note: str | None = None
    lines: list[_Line]


_app = FastAPI()


@_app.get("/doc-only", response_model=None, responses={200: {"model": _Answer}})
def _doc_only() -> dict[str, Any]:
    return {}


@_app.post("/created", response_model=None, status_code=201,
          responses={201: {"model": _Answer}})
def _created() -> dict[str, Any]:
    return {}


@_app.get("/untyped")
def _untyped() -> dict[str, Any]:
    return {}


GOOD = {"total": 2, "lines": [{"label": "a", "amount": 1.5}]}


def test_a_matching_answer_passes():
    assert check(_app, "GET", "/doc-only", 200, GOOD) == []
    assert check(_app, "GET", "/doc-only", 200, {**GOOD, "note": None}) == []


def test_an_undocumented_key_fails():
    errors = check(_app, "GET", "/doc-only", 200, {**GOOD, "secret": 1})
    assert errors == ["$.secret: sent but not in _Answer"]


def test_a_missing_required_key_fails():
    assert check(_app, "GET", "/doc-only", 200, {"lines": []})


def test_a_wrong_type_fails():
    assert check(_app, "GET", "/doc-only", 200, {**GOOD, "total": "two"})


def test_nested_rows_are_checked():
    bad = {"total": 1, "lines": [{"label": "a", "amount": 1, "extra": True}]}
    assert check(_app, "GET", "/doc-only", 200, bad) == [
        "$.lines[0].extra: sent but not in _Line",
    ]


def test_the_documented_status_is_used():
    assert documented_model(_app, "POST", "/created", 201) is _Answer
    assert check(_app, "POST", "/created", 201, {"total": 1}) != []


def test_errors_and_undocumented_routes_are_not_checked():
    assert check(_app, "GET", "/doc-only", 404, {"detail": "x"}) == []
    assert check(_app, "GET", "/untyped", 200, {"anything": 1}) == []


# ── Every JSON route documents its answer ─────────────────────────
#
# A route that answers JSON with no model would hand the SPA an
# untyped dict, and the SPA would keep a hand-written copy of its
# shape that drifts. Give it a model (doc-only as above when it builds
# a dict); a file download declares ``response_class=Response``.


def _untyped_routes() -> set[str]:
    spec = api_app.openapi()
    out = set()
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            responses = op.get("responses", {})
            ok = next((responses[k] for k in sorted(responses) if k.startswith("2")), {})
            schema = ok.get("content", {}).get("application/json", {}).get("schema")
            if schema is None:
                continue
            if "$ref" in schema or schema.get("type") == "array":
                continue
            if all("$ref" in v for v in schema.get("oneOf", [{}])):
                continue
            out.add(f"{method.upper()} {path}")
    return out


def test_every_json_route_documents_its_answer():
    assert sorted(_untyped_routes()) == [], (
        "document the answer: response_model=X, or response_model=None "
        "plus responses={200: {'model': X}} for a route that builds a "
        "dict; a download declares response_class=Response"
    )


def test_a_union_answer_matches_its_closest_shape():
    from typing import Literal

    class _A(BaseModel):
        kind: Literal["a"]
        x: int

    class _B(BaseModel):
        kind: Literal["b"]
        y: int

    assert shape_errors(_A | _B, {"kind": "b", "y": 1}) == []
    assert shape_errors(_A | _B, {"kind": "b", "y": 1, "z": 2}) == [
        "$.z: sent but not in _B",
    ]
