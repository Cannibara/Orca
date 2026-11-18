"""Parquet lake and ingest manifest."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

import polars as pl


class Lake:
    """Tables stored as zstd Parquet: root/table.parquet, or root/table/<part>.parquet. Every write
    is atomic: a file appears whole or not at all."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def write(self, table: str, df: pl.DataFrame, part: str | None = None) -> Path:
        if part is None:
            path = self.root / f"{table}.parquet"
        else:
            path = self.root / table / f"{part}.parquet"
        return _atomic(path, lambda tmp: df.write_parquet(tmp, compression="zstd"))

    def sink(self, table: str, frame: pl.LazyFrame) -> Path:
        """`write` of a lazy frame, streamed to disk rather than collected: for a table too big to
        hold in memory while it is rebuilt. `frame` may read the table it replaces."""
        return _atomic(
            self.root / f"{table}.parquet",
            lambda tmp: frame.sink_parquet(tmp, compression="zstd"),
        )

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


def _atomic(path: Path, write) -> Path:
    """`write(tmp)` to a temporary file next to `path`, then renamed over it: a table or part that
    is rewritten in place (a quarter's filings when new ones arrive, a year of prices when runs are
    compacted, the security master) is never left half written by a crash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    os.close(fd)
    try:
        write(tmp)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


class Manifest:
    """Records which inputs were ingested, as JSON {name: checksum}."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._entries: dict[str, str] = {}
        if self.path.exists():
            self._entries = json.loads(self.path.read_text())

    def seen(self, name: str, checksum: str) -> bool:
        return self._entries.get(name) == checksum

    def __contains__(self, name: str) -> bool:
        """Whether `name` was recorded, whatever its checksum."""
        return name in self._entries

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
