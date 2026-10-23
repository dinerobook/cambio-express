"""Every JSON answer a test receives must match the shape its route
documents in the OpenAPI spec (and so in the SPA's generated types).

A route documents its answer either with ``response_model=`` (FastAPI
then filters the output to it) or, for routes that still build a
plain dict, with ``response_model=None`` plus
``responses={200: {"model": X}}`` — documentation only, the answer
goes out byte for byte as the route built it. That second form is how
the untyped routes get types without any risk to live stores: the
route's behaviour is unchanged, and this check (run on every request
the test suite makes) proves the documented model has exactly the
fields the route really sends — no missing key, no undocumented one.
"""
from __future__ import annotations

import types
import typing
from typing import Any, Union, get_args, get_origin

from pydantic import BaseModel, TypeAdapter, ValidationError
from starlette.routing import Match

_ADAPTERS: dict[Any, TypeAdapter] = {}


def documented_model(app: Any, method: str, path: str, status: int) -> Any:
    """The model a route documents for ``status``, or None."""
    scope = {"type": "http", "method": method, "path": path,
             "root_path": "", "query_string": b"", "headers": []}
    for route in getattr(app, "routes", []):
        match, _ = route.matches(scope)
        if match != Match.FULL:
            continue
        documented = (getattr(route, "responses", None) or {}).get(status) or {}
        if "model" in documented:
            return documented["model"]
        status_code = getattr(route, "status_code", None) or 200
        if status == status_code:
            return getattr(route, "response_model", None)
        return None
    return None


def _unwrap(tp: Any) -> list[Any]:
    """The concrete types inside Optional / Union / Annotated."""
    origin = get_origin(tp)
    if origin is typing.Annotated:
        return _unwrap(get_args(tp)[0])
    if origin in (Union, types.UnionType):
        out: list[Any] = []
        for arg in get_args(tp):
            out.extend(_unwrap(arg))
        return out
    return [tp]


def shape_errors(tp: Any, value: Any, where: str = "$") -> list[str]:
    """Keys in ``value`` the model does not declare, and keys it
    declares as required that ``value`` lacks — recursively."""
    errors: list[str] = []
    if value is None:
        return errors
    for cand in _unwrap(tp):
        origin = get_origin(cand)
        if isinstance(cand, type) and issubclass(cand, BaseModel) and isinstance(value, dict):
            fields = {(f.alias or name): f for name, f in cand.model_fields.items()}
            if cand.model_config.get("extra") != "allow":
                for key in value:
                    if key not in fields:
                        errors.append(f"{where}.{key}: sent but not in {cand.__name__}")
            for key, field in fields.items():
                if key not in value:
                    if field.is_required():
                        errors.append(f"{where}.{key}: in {cand.__name__} but not sent")
                    continue
                errors.extend(shape_errors(field.annotation, value[key], f"{where}.{key}"))
            return errors
        if origin in (list, tuple, set, frozenset) and isinstance(value, list):
            args = get_args(cand)
            if args:
                for i, item in enumerate(value[:20]):
                    errors.extend(shape_errors(args[0], item, f"{where}[{i}]"))
            return errors
        if origin is dict and isinstance(value, dict):
            args = get_args(cand)
            if len(args) == 2:
                for k, item in list(value.items())[:20]:
                    errors.extend(shape_errors(args[1], item, f"{where}[{k!r}]"))
            return errors
    return errors


def check(app: Any, method: str, path: str, status: int, body: Any) -> list[str]:
    """Every way ``body`` differs from what its route documents."""
    if not (200 <= status < 300):
        return []
    model = documented_model(app, method, path, status)
    if model is None:
        return []
    adapter = _ADAPTERS.get(model)
    if adapter is None:
        adapter = _ADAPTERS[model] = TypeAdapter(model)
    try:
        adapter.validate_python(body)
    except ValidationError as e:
        return [f"{'.'.join(map(str, err['loc'])) or '$'}: {err['msg']}"
                for err in e.errors()[:10]]
    return shape_errors(model, body)
