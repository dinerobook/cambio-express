"""The transfer form's company + country pick-lists come from the
store's Settings (owner report 2026-10-13: the form had its own
hard-coded lists, so a company added in Settings for the MSB daily
book never reached the transfer form, and the countries could not be
managed at all).

Covers GET /transfers/choices (grant, deny, revoke, store scope), the
Settings write for the country list (success + every refusal), the
company-name cap that keeps a Settings company savable on a transfer,
and that saved transfers keep a company / country that later left the
lists."""
import pytest

from api.Modules.Tenancy.Models import Store
from api.Modules.Transfers.Services import (
    MAX_TRANSFER_COMPANY_NAME_LEN,
    MAX_TRANSFER_COUNTRY_NAME_LEN,
    TRANSFER_COUNTRIES,
    encode_mt_companies,
    encode_transfer_countries,
    store_transfer_countries,
)
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin
from tests.Modules.Transfers.test_transfer_update_delete import (
    _employee_with, _h, _put_body,
)
from tests.Modules.Transfers.test_transfers_controllers import (
    _seed_employee, _seed_transfer,
)


CHOICES = "/api/v2/transfers/choices"
STORE_INFO = "/api/v2/admin/store-info"


def _set_store(store_id, **cols):
    with db_session():
        s = db.session.get(Store, store_id)
        for k, v in cols.items():
            setattr(s, k, v)
        db.session.commit()


# ── Service ─────────────────────────────────────────────────────

def test_countries_default_to_the_list_the_form_always_had():
    """A store that never edited the list (NULL column — every store
    when this ships) gets exactly the countries the form showed."""
    assert store_transfer_countries(None) == list(TRANSFER_COUNTRIES)
    assert store_transfer_countries(Store(transfer_countries=None)) == list(
        TRANSFER_COUNTRIES)
    assert store_transfer_countries(Store(transfer_countries=" , ")) == list(
        TRANSFER_COUNTRIES)
    assert store_transfer_countries(
        Store(transfer_countries="Mexico, Cuba")) == ["Mexico", "Cuba"]


def test_encode_countries_trims_and_keeps_order():
    assert encode_transfer_countries([" Cuba ", "Mexico"]) == "Cuba,Mexico"


@pytest.mark.parametrize("names", [
    [],
    ["  "],
    ["Korea, South"],
    ["Mexico", "mexico"],
    ["X" * (MAX_TRANSFER_COUNTRY_NAME_LEN + 1)],
    [f"C{i}" for i in range(101)],
])
def test_encode_countries_refuses_bad_lists(names):
    with pytest.raises(ValueError):
        encode_transfer_countries(names)


def test_new_company_name_must_fit_a_transfer():
    """Transfer.company is 30 characters, so a company added in
    Settings must fit it or the transfer form could never save it."""
    long = "X" * (MAX_TRANSFER_COMPANY_NAME_LEN + 1)
    with pytest.raises(ValueError):
        encode_mt_companies([{"name": long, "enabled": True}])
    ok = "X" * MAX_TRANSFER_COMPANY_NAME_LEN
    assert encode_mt_companies([{"name": ok}])[0] == ok


def test_longer_company_already_on_the_roster_still_saves():
    """A store that saved a 31-40 character name before the cap keeps
    being able to save its Settings."""
    long = "Y" * (MAX_TRANSFER_COMPANY_NAME_LEN + 5)
    companies, _ = encode_mt_companies(
        [{"name": long}, {"name": "Maxi"}], existing=[long],
    )
    assert companies == f"{long},Maxi"


# ── GET /transfers/choices ─────────────────────────────────────

def test_choices_default_store(client, test_store_id):
    resp = client.get(CHOICES, headers=_h(login_admin(client, test_store_id)))
    assert resp.status_code == 200
    assert resp.get_json() == {
        "companies": ["Intermex", "Maxi", "Barri"],
        "countries": list(TRANSFER_COUNTRIES),
    }


def test_choices_follow_settings(client, test_store_id):
    """The very list the daily book uses: active companies only, in
    roster order; the store's own countries."""
    _set_store(test_store_id, companies="Sigue,Intermex,Maxi",
               companies_disabled="Maxi", transfer_countries="Cuba,Mexico")
    resp = client.get(CHOICES, headers=_h(login_admin(client, test_store_id)))
    assert resp.get_json() == {
        "companies": ["Sigue", "Intermex"], "countries": ["Cuba", "Mexico"],
    }


def test_choices_are_per_store(client, test_store_id):
    with db_session():
        other = Store(name="Choices Other", slug="choices-other",
                      is_active=True, companies="Ria",
                      transfer_countries="Peru")
        db.session.add(other)
        db.session.commit()
    body = client.get(
        CHOICES, headers=_h(login_admin(client, test_store_id))).get_json()
    assert "Ria" not in body["companies"]
    assert "Peru" in body["countries"]  # the default list, not the other store's


def test_choices_requires_auth(client):
    assert client.get(CHOICES).status_code == 401


def test_choices_for_employee_with_transfer_read(client, test_store_id):
    _, h = _employee_with(client, test_store_id, "choices_tr",
                          {"transfers": {"read": True}})
    assert client.get(CHOICES, headers=h).status_code == 200


def test_choices_for_employee_with_only_batch_read(client, test_store_id):
    """The ACH batch form picks a company from the same list."""
    _, h = _employee_with(client, test_store_id, "choices_br",
                          {"batches": {"read": True}})
    assert client.get(CHOICES, headers=h).status_code == 200


def test_choices_denied_without_either_right_and_on_revoke(
    client, test_store_id,
):
    from api.Core.Permissions import set_user_permissions
    uid, h = _employee_with(client, test_store_id, "choices_none",
                            {"transfers": {"read": True}})
    assert client.get(CHOICES, headers=h).status_code == 200
    set_user_permissions(test_store_id, uid, {"customers": {"read": True}})
    assert client.get(CHOICES, headers=h).status_code == 403


def test_choices_superadmin_has_no_store(client):
    resp = client.get(CHOICES, headers=_h(login_superadmin(client)))
    assert resp.status_code == 403


# ── Settings → Transfer countries ──────────────────────────────

def test_store_info_reads_default_countries(client, test_store_id):
    resp = client.get(STORE_INFO, headers=_h(login_admin(client, test_store_id)))
    assert resp.get_json()["store"]["transfer_countries"] == list(
        TRANSFER_COUNTRIES)


def test_admin_saves_countries_and_the_form_sees_them(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    resp = client.put(STORE_INFO, headers=h, json={
        "transfer_countries": ["Mexico", " Cuba ", "Venezuela"],
    })
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["store"]["transfer_countries"] == [
        "Mexico", "Cuba", "Venezuela"]
    assert client.get(CHOICES, headers=h).get_json()["countries"] == [
        "Mexico", "Cuba", "Venezuela"]
    # Saving other fields leaves the list alone.
    assert client.put(STORE_INFO, headers=h, json={"phone": "555"}).status_code == 200
    assert client.get(CHOICES, headers=h).get_json()["countries"][1] == "Cuba"


@pytest.mark.parametrize("countries", [
    [], ["Mexico", "MEXICO"], ["Korea, South"], [""],
])
def test_bad_country_list_is_refused_and_nothing_changes(
    client, test_store_id, countries,
):
    h = _h(login_admin(client, test_store_id))
    resp = client.put(STORE_INFO, headers=h,
                      json={"transfer_countries": countries})
    assert resp.status_code == 422
    with db_session():
        assert db.session.get(Store, test_store_id).transfer_countries is None


def test_employee_cannot_change_countries(client, test_store_id):
    _, h = _employee_with(client, test_store_id, "choices_set",
                          {"settings": {"read": True}})
    resp = client.put(STORE_INFO, headers=h,
                      json={"transfer_countries": ["Cuba"]})
    assert resp.status_code == 403
    with db_session():
        assert db.session.get(Store, test_store_id).transfer_countries is None


def test_settings_refuses_a_new_company_too_long_for_a_transfer(
    client, test_store_id,
):
    h = _h(login_admin(client, test_store_id))
    resp = client.put(STORE_INFO, headers=h, json={"mt_companies": [
        {"name": "Intermex"}, {"name": "Z" * 31},
    ]})
    assert resp.status_code == 422
    assert "too long" in resp.get_json()["detail"]


def test_settings_keeps_a_long_company_it_already_had(client, test_store_id):
    long = "L" * 35
    _set_store(test_store_id, companies=f"Intermex,{long}")
    h = _h(login_admin(client, test_store_id))
    resp = client.put(STORE_INFO, headers=h, json={"mt_companies": [
        {"name": "Intermex"}, {"name": long, "enabled": False},
    ]})
    assert resp.status_code == 200, resp.get_data(as_text=True)


# ── Saved transfers keep their values ──────────────────────────

def test_transfer_keeps_company_and_country_that_left_the_lists(
    client, test_store_id,
):
    """Removing a company or country in Settings only changes the
    pickers: an existing transfer still reads and re-saves with what
    it was saved with."""
    with db_session():
        emp = _seed_employee(test_store_id)
        tid = _seed_transfer(test_store_id, company="Vigo",
                             country="Honduras")
    _set_store(test_store_id, companies="Intermex",
               transfer_countries="Mexico")
    h = _h(login_admin(client, test_store_id))
    got = client.get(f"/api/v2/transfers/{tid}?store_ids={test_store_id}",
                     headers=h).get_json()
    assert got["transfer"]["company"] == "Vigo"
    assert got["transfer"]["country"] == "Honduras"
    resp = client.put(f"/api/v2/transfers/{tid}", headers=h, json=_put_body(
        emp, company="Vigo", country="Honduras", sender_name="Still here"))
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json()["transfer"]["company"] == "Vigo"
    assert resp.get_json()["transfer"]["country"] == "Honduras"
