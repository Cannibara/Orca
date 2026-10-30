import polars as pl

from orca.storage import Lake, Manifest, sha256_file


def test_roundtrip_partitioned(tmp_path):
    lake = Lake(tmp_path)
    lake.write("holdings", pl.DataFrame({"cik": [1, 2], "shares": [10.0, 20.0]}), part="q053")
    lake.write("holdings", pl.DataFrame({"cik": [3], "shares": [30.0]}), part="q052")

    out = lake.read("holdings")

    assert sorted(out["cik"].to_list()) == [1, 2, 3]
    assert lake.parts("holdings") == ["q052", "q053"]
    assert lake.read("holdings", part="q053")["cik"].to_list() == [1, 2]


def test_roundtrip_unpartitioned(tmp_path):
    lake = Lake(tmp_path)
    df = pl.DataFrame({"cusip": ["AAA", "BBB"], "ticker": ["A", "B"]})

    path = lake.write("securities", df)

    assert path == tmp_path / "securities.parquet"
    assert lake.read("securities").equals(df)
    assert lake.parts("securities") == []


def test_read_concatenates_parts_with_different_schemas(tmp_path):
    lake = Lake(tmp_path)
    lake.write("prices", pl.DataFrame({"px": [1.0]}), part="y2023")
    lake.write("prices", pl.DataFrame({"px": [2.0], "vol": [5.0]}), part="y2024")

    out = lake.read("prices")

    assert out.columns == ["px", "vol"]
    assert out["px"].to_list() == [1.0, 2.0]
    assert out["vol"].to_list() == [None, 5.0]


def test_read_missing_table_is_empty(tmp_path):
    lake = Lake(tmp_path)

    assert lake.read("nothing").is_empty()
    assert lake.read("nothing", part="q001").is_empty()
    assert lake.parts("nothing") == []


def test_manifest_skips_seen(tmp_path):
    path = tmp_path / "manifest.json"
    manifest = Manifest(path)
    assert not manifest.seen("filing-1", "abc")

    manifest.mark("filing-1", "abc")
    manifest.save()

    reloaded = Manifest(path)
    assert reloaded.seen("filing-1", "abc")
    assert not reloaded.seen("filing-1", "different")
    assert not reloaded.seen("filing-2", "abc")


def test_manifest_save_is_atomic_and_leaves_no_temp_files(tmp_path):
    path = tmp_path / "sub" / "manifest.json"
    manifest = Manifest(path)
    manifest.mark("a", "1")
    manifest.save()
    manifest.mark("a", "2")
    manifest.save()

    assert [p.name for p in path.parent.iterdir()] == ["manifest.json"]
    assert Manifest(path).seen("a", "2")


def test_sha256_file(tmp_path):
    f = tmp_path / "f.txt"
    f.write_bytes(b"abc")

    assert sha256_file(f) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
