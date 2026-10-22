"""Contracts every typed request body keeps, checked by walking the
live router (CLAUDE.md "typed request bodies").

Number fields refuse NaN and Infinity. Python's JSON parser accepts
the bare tokens ``NaN`` / ``Infinity`` and pydantic lets them through
a plain ``float`` by default, so before 2026-10-21 a daily-book entry
or transfer typed as "NaN" reached the money layer and answered 500
instead of a 422 the form can show. Every body model with a float in
it now carries ``ConfigDict(allow_inf_nan=False)``; a new one that
forgets fails here.
"""
from __future__ import annotations

import typing
from datetime import date

import pytest
from fastapi.routing import APIRoute
from pydantic import BaseModel

from tests.conftest import login_admin


def _body_models() -> set[type[BaseModel]]:
    from api.main import api_app
    seen: set[type[BaseModel]] = set()

    def walk(model: type[BaseModel]) -> None:
        if model in seen:
            return
        seen.add(model)
        for field in model.model_fields.values():
            stack = [field.annotation]
            while stack:
                ann = stack.pop()
                if isinstance(ann, type) and issubclass(ann, BaseModel):
                    walk(ann)
                stack.extend(typing.get_args(ann))

    for route in api_app.routes:
        if not isinstance(route, APIRoute):
            continue
        for param in route.dependant.body_params:
            ann = param.field_info.annotation
            if isinstance(ann, type) and issubclass(ann, BaseModel):
                walk(ann)
    return seen


def _has_float(model: type[BaseModel]) -> bool:
    for field in model.model_fields.values():
        stack = [field.annotation]
        while stack:
            ann = stack.pop()
            if ann is float:
                return True
            stack.extend(typing.get_args(ann))
    return False


def test_walk_finds_the_money_bodies():
    names = {m.__name__ for m in _body_models() if _has_float(m)}
    assert {"CreateTransferRequest", "LineItemCreateRequest",
            "DailyReportUpdateRequest", "MonthlyUpdateRequest"} <= names


def test_every_float_body_refuses_nan_and_infinity():
    offenders = sorted(
        f"{m.__module__}.{m.__name__}"
        for m in _body_models()
        if _has_float(m) and m.model_config.get("allow_inf_nan", True)
    )
    assert offenders == [], (
        "add allow_inf_nan=False to these request models' ConfigDict"
    )


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity", '"NaN"'])
def test_daily_book_entry_answers_422_not_500(client, test_store_id, token):
    headers = {
        "Authorization": f"Bearer {login_admin(client, test_store_id)}",
        "Content-Type": "application/json",
    }
    resp = client.post(
        f"/api/v2/daily/{test_store_id}/{date.today().isoformat()}/line-items",
        content='{"kind": "drop", "at_time": "10:00", "amount": %s}' % token,
        headers=headers,
    )
    assert resp.status_code == 422, resp.get_data(as_text=True)


def test_a_real_amount_still_saves(client, test_store_id):
    resp = client.post(
        f"/api/v2/daily/{test_store_id}/{date.today().isoformat()}/line-items",
        json={"kind": "drop", "at_time": "10:00", "amount": "250.00"},
        headers={"Authorization": f"Bearer {login_admin(client, test_store_id)}"},
    )
    assert resp.status_code == 201, resp.get_data(as_text=True)


def test_transfer_amount_refuses_nan(client, test_store_id):
    resp = client.post(
        "/api/v2/transfers",
        content='{"send_date": "%s", "company": "Intermex", "service_type": '
                '"Money Transfer", "sender_name": "A", "send_amount": NaN}'
                % date.today().isoformat(),
        headers={
            "Authorization": f"Bearer {login_admin(client, test_store_id)}",
            "Content-Type": "application/json",
        },
    )
    assert resp.status_code == 422
    assert "finite" in resp.get_data(as_text=True)
