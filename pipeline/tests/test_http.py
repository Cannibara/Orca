import json

import httpx
import pytest

from orca.http import Client, FetchError, figi_client, sec_client


class FakeTime:
    """Clock that only moves when sleep() is called, and records every sleep."""

    def __init__(self):
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_client(handler, t: FakeTime, rate_per_sec: float = 10, **kwargs) -> Client:
    return Client(
        rate_per_sec,
        {},
        transport=httpx.MockTransport(handler),
        sleep=t.sleep,
        clock=t.clock,
        **kwargs,
    )


def test_retries_then_succeeds():
    t = FakeTime()
    statuses = iter([503, 503, 200])
    client = make_client(lambda request: httpx.Response(next(statuses)), t)

    response = client.get("https://example.test/a")

    assert response.status_code == 200
    assert t.sleeps == [2, 4]


def test_gives_up_after_max_retries():
    t = FakeTime()
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(500)

    client = make_client(handler, t)

    with pytest.raises(FetchError) as exc:
        client.get("https://example.test/a")

    assert exc.value.url == "https://example.test/a"
    assert exc.value.status == 500
    assert len(calls) == 5  # first try + 4 retries
    assert t.sleeps == [2, 4, 8, 16]


def test_429_is_retried():
    t = FakeTime()
    statuses = iter([429, 200])
    client = make_client(lambda request: httpx.Response(next(statuses)), t)

    assert client.get("https://example.test/a").status_code == 200
    assert t.sleeps == [2]


def test_client_error_is_not_retried():
    t = FakeTime()
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(404)

    client = make_client(handler, t)

    with pytest.raises(FetchError) as exc:
        client.get("https://example.test/missing")

    assert exc.value.status == 404
    assert len(calls) == 1
    assert t.sleeps == []


def test_network_error_is_retried_then_succeeds():
    t = FakeTime()
    attempts = []

    def handler(request):
        attempts.append(request)
        if len(attempts) == 1:
            raise httpx.ConnectError("boom", request=request)
        return httpx.Response(200)

    client = make_client(handler, t)

    assert client.get("https://example.test/a").status_code == 200
    assert t.sleeps == [2]


def test_network_error_gives_up_with_no_status():
    t = FakeTime()

    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    client = make_client(handler, t, max_retries=2)

    with pytest.raises(FetchError) as exc:
        client.get("https://example.test/a")

    assert exc.value.url == "https://example.test/a"
    assert exc.value.status is None
    assert t.sleeps == [2, 4]


def test_sends_user_agent(monkeypatch):
    monkeypatch.setenv("ORCA_CONTACT", "test@example.com")
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200)

    sec_client(transport=httpx.MockTransport(handler)).get("https://data.sec.gov/x")

    assert seen[0].headers["User-Agent"] == "Orca research test@example.com"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_sec_client_requires_contact(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("ORCA_CONTACT", raising=False)
    else:
        monkeypatch.setenv("ORCA_CONTACT", value)

    with pytest.raises(RuntimeError, match="ORCA_CONTACT"):
        sec_client()


def test_rate_limit_spacing():
    t = FakeTime()
    client = make_client(lambda request: httpx.Response(200), t, rate_per_sec=10)

    for _ in range(11):
        client.get("https://example.test/a")

    # The first call is immediate; the other ten are spaced 0.1 s apart.
    assert t.now == pytest.approx(1.0)
    assert len(t.sleeps) == 10


def test_get_sends_params_and_extra_headers():
    t = FakeTime()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200)

    client = Client(
        10,
        {"X-Key": "abc"},
        transport=httpx.MockTransport(handler),
        sleep=t.sleep,
        clock=t.clock,
    )

    client.get("https://example.test/a", ticker="IBM", start="2020-01-01")

    assert seen[0].method == "GET"
    assert seen[0].url.params["ticker"] == "IBM"
    assert seen[0].url.params["start"] == "2020-01-01"
    assert seen[0].headers["X-Key"] == "abc"


def test_post_json_sends_body_and_extra_headers():
    t = FakeTime()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=[{"data": []}])

    client = Client(
        10,
        {"X-OPENFIGI-APIKEY": "k"},
        transport=httpx.MockTransport(handler),
        sleep=t.sleep,
        clock=t.clock,
    )

    response = client.post_json("https://example.test/map", [{"idType": "ID_CUSIP", "idValue": "X"}])

    assert response.json() == [{"data": []}]
    assert seen[0].method == "POST"
    assert json.loads(seen[0].content) == [{"idType": "ID_CUSIP", "idValue": "X"}]
    assert seen[0].headers["Content-Type"] == "application/json"
    assert seen[0].headers["X-OPENFIGI-APIKEY"] == "k"


def test_get_keeps_query_already_in_url():
    t = FakeTime()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200)

    client = make_client(handler, t)

    client.get("https://example.test/cgi-bin/browse-edgar?action=getcompany&CIK=1067983")

    assert str(seen[0].url) == "https://example.test/cgi-bin/browse-edgar?action=getcompany&CIK=1067983"


def test_get_merges_url_query_with_params():
    t = FakeTime()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200)

    client = make_client(handler, t)

    client.get("https://example.test/cgi-bin/browse-edgar?action=getcompany", type="13F")

    assert seen[0].url.path == "/cgi-bin/browse-edgar"
    assert dict(seen[0].url.params) == {"action": "getcompany", "type": "13F"}


def test_redirect_is_an_error_and_not_followed():
    t = FakeTime()
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(301, headers={"Location": "https://www.sec.gov/x"})

    client = make_client(handler, t)

    with pytest.raises(FetchError) as exc:
        client.get("https://sec.gov/x")

    assert exc.value.status == 301
    assert "https://www.sec.gov/x" in str(exc.value)
    assert len(calls) == 1
    assert t.sleeps == []


def test_retries_pass_through_the_rate_limiter():
    t = FakeTime()
    statuses = iter([503, 200])
    client = make_client(lambda request: httpx.Response(next(statuses)), t, rate_per_sec=25 / 60)

    assert client.get("https://example.test/a").status_code == 200

    # 2 s backoff refills 2 * 25/60 of a token; the limiter waits out the other 0.4 s.
    assert t.sleeps == [2, pytest.approx(0.4)]


def test_figi_client_with_key_is_fast_and_batches_100(monkeypatch):
    monkeypatch.setenv("OPENFIGI_KEY", "secret-key")
    t = FakeTime()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=[])

    client = figi_client(httpx.MockTransport(handler), sleep=t.sleep, clock=t.clock)
    for _ in range(3):
        client.post_json("https://api.openfigi.com/v3/mapping", [])

    assert client.jobs_per_request == 100
    assert seen[0].headers["X-OPENFIGI-APIKEY"] == "secret-key"
    # 25 requests per 6 s: the first call is immediate, the next two are 0.24 s apart.
    assert t.sleeps == [pytest.approx(0.24)] * 2


@pytest.mark.parametrize("value", [None, "", "   "])
def test_figi_client_without_key_is_slow_and_batches_10(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("OPENFIGI_KEY", raising=False)
    else:
        monkeypatch.setenv("OPENFIGI_KEY", value)
    t = FakeTime()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=[])

    client = figi_client(httpx.MockTransport(handler), sleep=t.sleep, clock=t.clock)
    for _ in range(3):
        client.post_json("https://api.openfigi.com/v3/mapping", [])

    assert client.jobs_per_request == 10
    assert "X-OPENFIGI-APIKEY" not in seen[0].headers
    # 25 requests per minute: 2.4 s apart.
    assert t.sleeps == [pytest.approx(2.4)] * 2
