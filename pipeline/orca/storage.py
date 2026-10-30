"""Parquet lake and ingest manifest."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

import polars as pl


class Lake:
    """Tables stored as zstd Parquet: root/table.parquet, or root/table/<part>.parquet."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def write(self, table: str, df: pl.DataFrame, part: str | None = None) -> Path:
        if part is None:
            path = self.root / f"{table}.parquet"
        else:
            path = self.root / table / f"{part}.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        df.write_parquet(path, compression="zstd")
        return path

    def read(self, table: str, part: str | None = None) -> pl.DataFrame:
        if part is not None:
            files = [self.root / table / f"{part}.parquet"]
        else:
            files = [self.root / f"{table}.parquet"]
            files += [self.root / table / f"{p}.parquet" for p in self.parts(table)]
        frames = [pl.read_parquet(f) for f in files if f.exists()]
        if not frames:
            return pl.DataFrame()
        return pl.concat(frames, how="diagonal_relaxed")

    def parts(self, table: str) -> list[str]:
        directory = self.root / table
        if not directory.is_dir():
            return []
        return sorted(p.stem for p in directory.glob("*.parquet"))


class Manifest:
    """Records which inputs were ingested, as JSON {name: checksum}."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._entries: dict[str, str] = {}
        if self.path.exists():
            self._entries = json.loads(self.path.read_text())

    def seen(self, name: str, checksum: str) -> bool:
        return self._entries.get(name) == checksum

    def mark(self, name: str, checksum: str) -> None:
        self._entries[name] = checksum

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(self._entries, f, sort_keys=True)
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
