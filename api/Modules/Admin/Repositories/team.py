"""Team-roster (StoreEmployee) SQL helpers."""
from sqlalchemy.orm import Session

from api.Modules.Admin.Models import StoreEmployee


def find_team_member(
    db: Session, store_id: int, employee_id: int,
) -> StoreEmployee | None:
    return (
        db.query(StoreEmployee)
          .filter_by(id=employee_id, store_id=store_id)
          .first()
    )
