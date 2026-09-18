"""Unit tests for BankSync.Services.categories (PR 69)."""
from api.Modules.BankSync.Models import StripeBankAccount
from tests._app import db, db_session


# ── bank_category_label ────────────────────────────────────


def test_label_returns_uncategorized_for_empty():
    from api.Modules.BankSync.Services import bank_category_label
    assert bank_category_label("") == "Uncategorized"
    assert bank_category_label(None) == "Uncategorized"


def test_label_uses_static_non_posting_dict():
    from api.Modules.BankSync.Services import (
        BANK_CATEGORIES_NON_POSTING, bank_category_label,
    )
    assert bank_category_label("internal_transfer") == \
        BANK_CATEGORIES_NON_POSTING["internal_transfer"]
    assert bank_category_label("ignore") == \
        "Ignore (don't reconcile)"


def test_label_renders_dynamic_bank_charge_per_account():
    """bank_charge_<last4> not in the static dict → uniform
    'Bank charge — ••<last4>' label."""
    from api.Modules.BankSync.Services import bank_category_label
    assert bank_category_label("bank_charge_9999") == \
        "Bank charge — ••9999"


def test_label_for_daily_book_kind_titlecases_singular():
    """DailyBook kinds get the singular label titlecased."""
    from api.Modules.BankSync.Services import bank_category_label
    # cash_expense → "Cash Expense" (titlecased)
    assert bank_category_label("cash_expense") == "Cash Expense"
    # check_deposit → "Check Deposit"
    assert bank_category_label("check_deposit") == "Check Deposit"


def test_label_falls_through_to_raw_slug():
    """Unknown slug → return the slug itself (so debugging is
    easy if a stale slug ever leaks into the UI)."""
    from api.Modules.BankSync.Services import bank_category_label
    assert bank_category_label("totally_made_up") == "totally_made_up"


# ── is_daily_book_kind ─────────────────────────────────────


def test_is_daily_book_kind_true_for_registered():
    from api.Modules.BankSync.Services import is_daily_book_kind
    assert is_daily_book_kind("cash_expense") is True
    assert is_daily_book_kind("drop") is True


def test_is_daily_book_kind_false_for_non_posting_tag():
    from api.Modules.BankSync.Services import is_daily_book_kind
    assert is_daily_book_kind("internal_transfer") is False
    assert is_daily_book_kind("ignore") is False


def test_is_daily_book_kind_false_for_blank_or_none():
    from api.Modules.BankSync.Services import is_daily_book_kind
    assert is_daily_book_kind("") is False
    assert is_daily_book_kind(None) is False


# ── is_valid_bank_category ─────────────────────────────────


def test_is_valid_accepts_daily_book_kind():
    from tests._app import db
    from api.Modules.BankSync.Services import is_valid_bank_category
    with db_session():
        assert is_valid_bank_category(
            db.session, "cash_expense", store_id=1,
        ) is True


def test_is_valid_accepts_static_non_posting():
    from tests._app import db
    from api.Modules.BankSync.Services import is_valid_bank_category
    with db_session():
        assert is_valid_bank_category(
            db.session, "internal_transfer", store_id=1,
        ) is True
        assert is_valid_bank_category(
            db.session, "ignore", store_id=1,
        ) is True


def test_is_valid_rejects_blank():
    from tests._app import db
    from api.Modules.BankSync.Services import is_valid_bank_category
    with db_session():
        assert is_valid_bank_category(
            db.session, "", store_id=1,
        ) is False
        assert is_valid_bank_category(
            db.session, None, store_id=1,
        ) is False


def test_is_valid_rejects_unknown_slug():
    from tests._app import db
    from api.Modules.BankSync.Services import is_valid_bank_category
    with db_session():
        assert is_valid_bank_category(
            db.session, "made_up_slug", store_id=1,
        ) is False


def test_is_valid_accepts_dynamic_bank_charge_for_connected_account():
    """bank_charge_<last4> validates against the store's
    connected `StripeBankAccount` rows."""
    from api.Modules.Tenancy.Models import Store
    from tests._app import db
    from api.Modules.BankSync.Services import is_valid_bank_category
    with db_session():
        db.session.query(StripeBankAccount).delete()
        db.session.commit()
        s = Store(name="bc-store", slug="bc-store",
                  plan="basic", email="bc@example.com")
        db.session.add(s); db.session.flush()
        db.session.add(StripeBankAccount(
            store_id=s.id,
            stripe_account_id="fcacct_x",
            last4="0210",
        ))
        db.session.flush()
        # Stripped form
        assert is_valid_bank_category(
            db.session, "bank_charge_210", store_id=s.id,
        ) is True
        # Original form (with leading zero)
        assert is_valid_bank_category(
            db.session, "bank_charge_0210", store_id=s.id,
        ) is True
        # Different account → invalid
        assert is_valid_bank_category(
            db.session, "bank_charge_9999", store_id=s.id,
        ) is False


def test_is_valid_rejects_bank_charge_with_empty_suffix():
    """`bank_charge_` with no suffix is junk."""
    from tests._app import db
    from api.Modules.BankSync.Services import is_valid_bank_category
    with db_session():
        assert is_valid_bank_category(
            db.session, "bank_charge_", store_id=1,
        ) is False


# ── bank_category_groups ───────────────────────────────────


def test_groups_returns_three_top_level_groups():
    """Daily book (books a line), Monthly P&L (feeds a column),
    Other (tag only) — in the order the operator reads them."""
    from tests._app import db
    from api.Modules.BankSync.Services import bank_category_groups
    with db_session():
        result = bank_category_groups(db.session)
        assert len(result) == 3
        labels = [g[0] for g in result]
        assert labels == [
            "Daily book",
            "Monthly P&L",
            "Other (no daily-book impact)",
        ]
        pl_slugs = {slug for slug, _ in result[1][1]}
        assert "pl_credit_card_fees" in pl_slugs
        assert "pl_other_income_1" in pl_slugs


def test_groups_includes_static_non_posting_tags():
    from tests._app import db
    from api.Modules.BankSync.Services import bank_category_groups
    with db_session():
        result = bank_category_groups(db.session)
        other_slugs = {slug for slug, _ in result[2][1]}
        assert "internal_transfer" in other_slugs
        assert "ignore" in other_slugs


def test_groups_augments_other_with_per_account_bank_charges():
    """Connected accounts get dynamic bank_charge_<last4> entries
    in the Other group."""
    from api.Modules.Tenancy.Models import Store
    from tests._app import db
    from api.Modules.BankSync.Services import bank_category_groups
    with db_session():
        db.session.query(StripeBankAccount).delete()
        db.session.commit()
        s = Store(name="grp-store", slug="grp-store",
                  plan="basic", email="grp@example.com")
        db.session.add(s); db.session.flush()
        # An account whose stripped slug isn't in the static dict.
        db.session.add(StripeBankAccount(
            store_id=s.id,
            stripe_account_id="fcacct_y",
            last4="9999",
        ))
        db.session.flush()
        result = bank_category_groups(db.session, store_id=s.id)
        other_slugs = {slug for slug, _ in result[2][1]}
        assert "bank_charge_9999" in other_slugs


def test_groups_does_not_duplicate_static_slugs():
    """If an account's last4 maps to a slug already in the static
    dict (210/230), don't double-add it."""
    from api.Modules.Tenancy.Models import Store
    from tests._app import db
    from api.Modules.BankSync.Services import bank_category_groups
    with db_session():
        db.session.query(StripeBankAccount).delete()
        db.session.commit()
        s = Store(name="dup-store", slug="dup-store",
                  plan="basic", email="dup@example.com")
        db.session.add(s); db.session.flush()
        db.session.add(StripeBankAccount(
            store_id=s.id,
            stripe_account_id="fcacct_z",
            last4="0210",
        ))
        db.session.flush()
        result = bank_category_groups(db.session, store_id=s.id)
        other_slugs = [slug for slug, _ in result[2][1]]
        assert other_slugs.count("bank_charge_210") == 1


# ── legacy Flask wrappers ──────────────────────────────────












# ── the store's own P&L names in the picker ────────────────
#
# The P&L slots are blank by design and the store names them (see
# Monthly/Services/labels.py). Two things follow for the picker:
# it shows the store's name rather than ours, and it leaves out a
# slot nobody has claimed — "Other expense 4" in a dropdown is a
# slug you cannot pick meaningfully, and the list is long enough
# without eight of them.


def _store(slug):
    from api.Modules.Tenancy.Models import Store
    from tests._app import db
    s = Store(name=slug, slug=slug, plan="basic",
              email=f"{slug}@example.com")
    db.session.add(s); db.session.flush()
    return s


def _pl_options(db_session_, store_id):
    from api.Modules.BankSync.Services import bank_category_groups
    groups = bank_category_groups(db_session_, store_id)
    return dict(groups[1][1])


def test_unclaimed_slots_are_left_out_of_the_picker():
    from tests._app import db
    with db_session():
        s = _store("slot-hidden")
        options = _pl_options(db.session, s.id)
        assert "pl_credit_card_fees" in options
        assert "pl_other_expense_1" not in options
        assert "pl_other_income_1" not in options


def test_naming_a_slot_puts_it_in_the_picker_under_that_name():
    """The operator's whole journey: they wanted a 'Bank Fee'
    category, could not find one, so they name a blank slot and it
    turns up in the rule form."""
    from api.Modules.Monthly.Services import set_line_labels
    from tests._app import db
    with db_session():
        s = _store("slot-named")
        set_line_labels(db.session, s.id, {"other_expense_1": "Bank Fee"})
        db.session.flush()
        options = _pl_options(db.session, s.id)
        assert options["pl_other_expense_1"] == "Bank Fee"


def test_renaming_a_shipped_line_renames_it_in_the_picker():
    from api.Modules.Monthly.Services import set_line_labels
    from tests._app import db
    with db_session():
        s = _store("line-renamed")
        set_line_labels(db.session, s.id,
                        {"emaginenet_tech": "Internet & POS"})
        db.session.flush()
        options = _pl_options(db.session, s.id)
        assert options["pl_emaginenet_tech"] == "Internet & POS"


def test_a_slot_already_in_use_stays_in_the_picker_unnamed():
    """A store that tagged a slot and later cleared its name must
    not find its own rule refused — the picker and the validator
    are the same list, so a slug in use stays in both."""
    from api.Modules.BankSync.Models import BankRule
    from api.Modules.BankSync.Services import is_valid_bank_category
    from tests._app import db
    with db_session():
        s = _store("slot-in-use")
        db.session.add(BankRule(
            store_id=s.id, desc_match_type="contains",
            desc_match_value="FEE", target_kind="pl_other_expense_2",
        ))
        db.session.flush()
        assert "pl_other_expense_2" in _pl_options(db.session, s.id)
        assert is_valid_bank_category(
            db.session, "pl_other_expense_2", store_id=s.id,
        ) is True


def test_an_unclaimed_slot_is_refused_by_the_server():
    """The invariant the picker and the validator share: a slug the
    SPA does not offer is a slug the server does not take."""
    from api.Modules.BankSync.Services import is_valid_bank_category
    from tests._app import db
    with db_session():
        s = _store("slot-refused")
        assert is_valid_bank_category(
            db.session, "pl_other_expense_1", store_id=s.id,
        ) is False


def test_picker_and_validator_never_disagree():
    """Belt and braces on the rule that used to be kept by hand:
    everything offered validates, for a store with a named slot, a
    connected account and a rule of its own."""
    from api.Modules.BankSync.Models import BankRule
    from api.Modules.BankSync.Services import (
        bank_category_groups, is_valid_bank_category,
    )
    from api.Modules.Monthly.Services import set_line_labels
    from tests._app import db
    with db_session():
        s = _store("in-step")
        db.session.add(StripeBankAccount(
            store_id=s.id, stripe_account_id="fcacct_step", last4="0777",
        ))
        db.session.add(BankRule(
            store_id=s.id, desc_match_type="contains",
            desc_match_value="X", target_kind="pl_other_income_2",
        ))
        set_line_labels(db.session, s.id, {"other_expense_3": "Waste"})
        db.session.flush()
        for _label, options in bank_category_groups(db.session, s.id):
            for slug, _opt in options:
                assert is_valid_bank_category(
                    db.session, slug, store_id=s.id,
                ) is True, slug


def test_bank_charge_option_uses_the_account_nickname():
    """A store that renamed ••0230 should read its own words here
    too, not a number it has stopped thinking in."""
    from api.Modules.BankSync.Services import bank_category_groups
    from tests._app import db
    with db_session():
        db.session.query(StripeBankAccount).delete()
        db.session.commit()
        s = _store("nick-store")
        db.session.add(StripeBankAccount(
            store_id=s.id, stripe_account_id="fcacct_nick",
            last4="0230", nickname="MSB checking",
        ))
        db.session.flush()
        other = dict(bank_category_groups(db.session, s.id)[2][1])
        assert other["bank_charge_230"] == "Bank charge — MSB checking"


def test_label_renders_the_store_name_when_given_one():
    from api.Modules.BankSync.Services import bank_category_label
    assert bank_category_label("pl_other_expense_1") == \
        "P&L · Other expense 1"
    assert bank_category_label(
        "pl_other_expense_1", {"other_expense_1": "Bank Fee"},
    ) == "P&L · Bank Fee"
