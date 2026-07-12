from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database import Base, ROOT_DIR, SessionLocal
from app.services import export_backup, restore_backup


def normalize_postgres_url(url: str) -> str:
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def main() -> None:
    cloud_url = os.environ.get("FINANCE_CLOUD_DB_URL", "").strip()
    if not cloud_url:
        raise SystemExit("FINANCE_CLOUD_DB_URL is required")

    source_path = Path(os.environ.get("FINANCE_SOURCE_DB", ROOT_DIR / "data" / "finance.db"))
    if not source_path.exists():
        raise SystemExit(f"Source database does not exist: {source_path}")

    # SessionLocal points to the existing local SQLite database unless the caller
    # explicitly overrides FINANCE_DB_URL. Export first, then replace cloud data in
    # one controlled restore so account, transaction, and position IDs stay linked.
    with SessionLocal() as source_db:
        payload = export_backup(source_db)

    cloud_engine = create_engine(normalize_postgres_url(cloud_url), pool_pre_ping=True)
    Base.metadata.create_all(bind=cloud_engine)
    with Session(cloud_engine) as cloud_db:
        restored = restore_backup(cloud_db, payload)

    total = sum(restored.values())
    print(f"Migration complete: {total} records across {len(restored)} tables.")


if __name__ == "__main__":
    main()
