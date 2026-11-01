import httpx
import pytest

from orca.http import FetchError, figi_client
from orca.run import preflight
from orca.run.cli import main
from orca.run.preflight import Probe, check_keys

KEY = "s3cr3t-key-value"


def failing(status):
    def call():
        raise FetchError(f"https://example.test/x?api_key={KEY}", status)

    return call


def not_set():
    raise RuntimeError("TIINGO_KEY is not set.")


def probe(call, secret="TIINGO_KEY"):
    return Probe(secret, "Tiingo", "tiingo.com", call)


def test_all_keys_good():
    assert check_keys([probe(lambda: None), probe(lambda: None, "FRED_KEY")]) == []


@pytest.mark.parametrize("status", [400, 401, 403])
def test_refused_key_names_the_secret(status):
    [problem] = check_keys([probe(failing(status))])
    assert f"refused TIINGO_KEY (HTTP {status})" in problem
    assert "tiingo.com" in problem


def test_other_status_and_network_error():
    problems = check_keys([probe(failing(500)), probe(failing(None))])
    assert "HTTP 500" in problems[0]
    assert "could not be reached" in problems[1]


def test_unset_key():
    assert check_keys([probe(not_set)]) == [
        "TIINGO_KEY is not set. Add it as a secret of the environment."
    ]


def test_messages_never_hold_the_key_or_url():
    problems = check_keys([probe(failing(s)) for s in (401, 500, None)])
    assert all(KEY not in p and "example.test" not in p for p in problems)


def figi_answering(monkeypatch, payload, status=200):
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=payload))
    monkeypatch.setattr(
        preflight, "figi_client", lambda: figi_client(transport, sleep=lambda s: None)
    )


def test_openfigi_probe_accepts_a_mapped_cusip(monkeypatch):
    figi_answering(monkeypatch, [{"data": [{"figi": "BBG000BDTBL9", "ticker": "SPY"}]}])
    preflight._openfigi()


def test_openfigi_probe_rejects_an_unmapped_answer(monkeypatch):
    figi_answering(monkeypatch, [{"error": "Invalid idValue format"}])
    with pytest.raises(FetchError):
        preflight._openfigi()


def test_openfigi_probe_refused_key(monkeypatch):
    figi_answering(monkeypatch, "Invalid API key.", status=401)
    with pytest.raises(FetchError) as err:
        preflight._openfigi()
    assert err.value.status == 401


def test_cli_check_keys_fails_on_a_problem(monkeypatch, capsys):
    monkeypatch.setattr(preflight, "production_probes", lambda: [probe(failing(401))])
    assert main(["check-keys"]) == 1
    out = capsys.readouterr().out
    assert "::error::Tiingo refused TIINGO_KEY (HTTP 401)" in out


def test_cli_check_keys_passes(monkeypatch, capsys):
    monkeypatch.setattr(preflight, "production_probes", lambda: [probe(lambda: None)])
    assert main(["check-keys"]) == 0
    assert "check-keys: 0 problem(s)" in capsys.readouterr().out
