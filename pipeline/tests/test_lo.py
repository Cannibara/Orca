"""The LibreOffice helper's own failure handling (ruling R20): a failed run says what soffice
printed, and a run past its timeout is killed with every process it started."""

import os
import stat
import time
from pathlib import Path

import lo
import pytest


def _fake_soffice(bin_dir: Path, body: str) -> None:
    script = bin_dir / "soffice"
    script.write_text(f"#!/bin/sh\n{body}\n")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)


def test_failure_shows_stderr(tmp_path, monkeypatch):
    _fake_soffice(tmp_path, 'echo "source file could not be loaded" >&2; exit 1')
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    with pytest.raises(RuntimeError, match="source file could not be loaded"):
        lo.recalc(tmp_path / "x.xlsx", tmp_path / "out")


def test_no_output_shows_stderr(tmp_path, monkeypatch):
    _fake_soffice(tmp_path, 'echo "Error: no export filter" >&2; exit 0')
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    with pytest.raises(RuntimeError, match="no export filter"):
        lo.recalc(tmp_path / "x.xlsx", tmp_path / "out")


def test_timeout_kills_the_process_group(tmp_path, monkeypatch):
    # soffice starts soffice.bin and returns only when it ends; the child must die too
    pid_file = tmp_path / "child.pid"
    _fake_soffice(tmp_path, f"sleep 60 & echo $! > {pid_file}; wait")
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setattr(lo, "TIMEOUT", 1)
    with pytest.raises(RuntimeError, match="timed out"):
        lo.recalc(tmp_path / "x.xlsx", tmp_path / "out")
    child = int(pid_file.read_text())
    for _ in range(50):  # the kill is sent; give the kernel a moment
        if not _running(child):
            return
        time.sleep(0.02)
    pytest.fail(f"child {child} still running after the timeout")


def _running(pid: int) -> bool:
    """Alive and not a zombie: a container's PID 1 may never reap the killed child."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except FileNotFoundError:
        return False
    return state not in ("Z", "X")
