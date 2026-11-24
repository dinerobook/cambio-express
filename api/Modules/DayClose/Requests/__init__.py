"""DayClose — Request/response schemas.

Money crosses the API as dollars floats (the app-wide contract);
cents stay in the DB + Services (P0-3 convention). ``cash_counted``
is nullable end-to-end: null means "drawer not counted", which is
different from a counted $0.00.
"""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from api.Core.Uploads import b64_len

# Same values as ``DEPARTMENT_TYPES`` in the Models (a test keeps the
# two in step); spelled out so the SPA gets a typed union.
DepartmentType = Literal[
    "merchandise",
    "fuel",
    "lottery_sell", "lottery_cash", "lotto_sell", "lotto_cash",
    "money_order", "money_order_fee", "money_transfer",
    "money_transfer_fee", "check_cash_fee", "service",
    "misc",
]

# The register's department number ("POS Dept No"): digits as the
# register sends them, kept as text so leading zeros survive.
PosCode = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[0-9A-Za-z]{1,20}$"),
]
NacsCode = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[0-9A-Za-z]{0,10}$"),
]


class DepartmentWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    name:       str = Field(..., min_length=1, max_length=80)
    sort_order: int = Field(0, ge=0, le=10000)
    parent_id:  int | None = Field(None, ge=1)
    department_type: DepartmentType = "merchandise"
    is_taxable: bool = True
    # The department's own tax rate as a fraction (0.0825 = 8.25 %);
    # None = not set. Ignored (stored as none) when not taxable.
    tax_rate:   float | None = Field(None, ge=0, le=1)
    min_age:    int | None = Field(None, ge=1, le=99)
    nacs_code:  NacsCode = ""
    pos_codes:  list[PosCode] = Field(default_factory=list, max_length=20)


class DepartmentUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    name:       str | None = Field(None, min_length=1, max_length=80)
    sort_order: int | None = Field(None, ge=0, le=10000)
    is_active:  bool | None = None
    # 0 clears the parent link (None = leave unchanged — see the
    # PATCH-style semantics in update_department).
    parent_id:  int | None = Field(None, ge=0)
    department_type: DepartmentType | None = None
    is_taxable: bool | None = None
    # A fraction (0.0825 = 8.25 %). 0 clears it, None = leave
    # unchanged. Turning taxable off clears it too.
    tax_rate:   float | None = Field(None, ge=0, le=1)
    # 0 clears the age limit (None = leave unchanged).
    min_age:    int | None = Field(None, ge=0, le=99)
    nacs_code:  NacsCode | None = None
    # The complete list of register numbers for this department
    # (None = leave unchanged, [] = none).
    pos_codes:  list[PosCode] | None = Field(None, max_length=20)


class DepartmentRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    sort_order: int
    is_active: bool
    parent_id: int | None
    parent_name: str
    department_type: DepartmentType
    is_taxable: bool
    tax_rate: float | None
    min_age: int | None
    nacs_code: str
    pos_codes: list[str]


class DepartmentListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    departments: list[DepartmentRow]


class DepartmentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department: DepartmentRow


# ── Modisoft department import ─────────────────────────────

# A Modisoft departments export is a few kilobytes; this leaves room.
MAX_DEPARTMENT_IMPORT_BYTES = 2 * 1024 * 1024
MAX_DEPARTMENT_IMPORT_ROWS = 2_000

# DineroBook's type group for a Modisoft type ("" = blank or unknown).
TypeGroup = Literal["merchandise", "fuel", "lottery", "services", "misc", ""]
DepartmentName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80),
]


class DepartmentImportCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content_base64: str = Field(
        ..., min_length=1, max_length=b64_len(MAX_DEPARTMENT_IMPORT_BYTES),
    )


class DepartmentImportCheckRow(BaseModel):
    """One department of the file, planned against the store."""
    model_config = ConfigDict(extra="forbid")

    line: int
    name: str
    pos_code: str | None
    modisoft_type: str
    type_group: TypeGroup
    # DineroBook's type: exact for Fuel / Merchandise / Misc, a guess
    # from the name for Lottery / Services (type_sure false).
    department_type: DepartmentType
    type_sure: bool
    is_taxable: bool | None
    tax_rate: float | None
    # 0 = no age limit, None = the cell was blank.
    min_age: int | None
    nacs_code: str | None
    items: int | None
    status: Literal["new", "update", "same", "skip"]
    existing_id: int | None
    existing_name: str
    existing_type: DepartmentType | None
    changes: list[Literal["name", "type", "tax", "age", "nacs", "pos"]]
    problem: Literal["duplicate_name", "duplicate_pos", "pos_taken", "name_taken"] | None
    problem_name: str
    # Not on the register (Modisoft's -1) and no items: offered unticked.
    unused: bool
    include: bool


class DepartmentImportIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Literal["no_name", "bad_number", "bad_pos", "bad_nacs"]
    count: int
    lines: list[int]


class DepartmentImportCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[DepartmentImportCheckRow]
    columns_used: list[str]
    columns_ignored: list[str]
    issues: list[DepartmentImportIssue]


class DepartmentImportRow(BaseModel):
    """A reviewed row: the file's values plus the type the person chose.
    None leaves a matched department's value alone."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    name:       DepartmentName
    pos_code:   PosCode | None = None
    department_type: DepartmentType
    is_taxable: bool | None = None
    tax_rate:   float | None = Field(None, ge=0, le=1)
    # 0 = no age limit.
    min_age:    int | None = Field(None, ge=0, le=99)
    nacs_code:  NacsCode | None = None


class DepartmentImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    rows: list[DepartmentImportRow] = Field(
        ..., min_length=1, max_length=MAX_DEPARTMENT_IMPORT_ROWS,
    )


class DepartmentImportResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    created: int
    updated: int
    unchanged: int


class DepartmentSaleLine(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    department_id: int = Field(..., ge=1)
    # May be below zero: a paid-out department (lottery cashed) is a
    # minus line on a register's close. The register import writes
    # such lines, and saving that close again by hand (to count its
    # drawer) sends them back, so this route must take them.
    amount:        float


class RegisterCloseWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    register_label: str = Field(..., min_length=1, max_length=40)
    shift_label:    str = Field("", max_length=40)
    gross_sales:    float = Field(..., ge=0)
    sales_tax:      float = Field(0, ge=0)
    cash_total:     float = Field(0, ge=0)
    card_total:     float = Field(0, ge=0)
    other_total:    float = Field(0, ge=0)
    cash_counted:   float | None = Field(None, ge=0)
    notes:          str = Field("", max_length=500)
    department_sales: list[DepartmentSaleLine] = Field(
        default_factory=list, max_length=200,
    )


class DepartmentSaleRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_id: int
    department_name: str
    amount: float


class RegisterCloseRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    register_label: str
    shift_label: str
    gross_sales: float
    sales_tax: float
    cash_total: float
    card_total: float
    other_total: float
    cash_counted: float | None
    over_short: float | None
    tender_variance: float
    notes: str
    source: str
    department_sales: list[DepartmentSaleRow]


class DepartmentTotalRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_id: int
    department_name: str
    amount: float


class DayCloseSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: str
    closes: list[RegisterCloseRow]
    department_totals: list[DepartmentTotalRow]
    gross_sales: float
    sales_tax: float
    cash_total: float
    card_total: float
    other_total: float
    over_short: float | None
    tender_variance: float
    uncounted_drawers: int
