import traceback

import httpx
import pytest

from orca.http import FetchError, fred_client
from orca.rf import FRED_URL, fetch_tbill

KEY = "s3cr3tfredkey"


@pytest.fixture(autouse=True)
def fred_key(monkeypatch):
    monkeypatch.setenv("FRED_KEY", KEY)


def client_for(handler):
    return fred_client(httpx.MockTransport(handler), sleep=lambda seconds: None)


def observations(*pairs):
    return {"observations": [{"date": d, "value": v} for d, v in pairs]}


def serve(payload):
    return client_for(lambda request: httpx.Response(200, json=payload))


def test_tbill_yearly_average():
    client = serve(observations(("2023-01-03", "4.0"), ("2023-06-01", "5.0")))
    assert fetch_tbill(client) == {2023: pytest.approx(0.045)}


def test_tbill_averages_each_year_on_its_own():
    client = serve(
        observations(
            ("2022-12-30", "4.0"),
            ("2023-01-03", "4.32"),
            ("2023-01-04", "4.36"),
            ("2024-01-02", "5.0"),
        )
    )
    assert fetch_tbill(client) == {
        2022: pytest.approx(0.04),
        2023: pytest.approx(0.0434),
        2024: pytest.approx(0.05),
    }


def test_tbill_skips_missing_values():
    client = serve(
        observations(("2023-01-02", "."), ("2023-01-03", "4.0"), ("2023-01-04", "5.0"))
    )
    assert fetch_tbill(client) == {2023: pytest.approx(0.045)}


def test_tbill_year_with_only_missing_values_is_absent():
    client = serve(observations(("2023-01-02", "."), ("2024-01-02", "5.0")))
    assert fetch_tbill(client) == {2024: pytest.approx(0.05)}


def test_tbill_without_observations_is_empty():
    assert fetch_tbill(serve(observations())) == {}


def test_tbill_request_asks_fred_for_dtb3_since_2013_with_the_key_as_a_parameter():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=observations())

    fetch_tbill(client_for(handler))

    assert len(seen) == 1
    request = seen[0]
    assert request.method == "GET"
    assert str(request.url).split("?")[0] == "https://api.stlouisfed.org/fred/series/observations"
    assert FRED_URL == "https://api.stlouisfed.org/fred/series/observations"
    assert dict(request.url.params) == {
        "series_id": "DTB3",
        "file_type": "json",
        "observation_start": "2013-01-01",
        "api_key": KEY,
    }


def test_tbill_key_is_read_at_call_time_and_trimmed(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request.url.params["api_key"])
        return httpx.Response(200, json=observations())

    client = client_for(handler)  # built before the key changes
    monkeypatch.setenv("FRED_KEY", "  other-key \n")
    fetch_tbill(client)
    assert seen == ["other-key"]


@pytest.mark.parametrize("value", [None, "", "   "])
def test_tbill_requires_a_key(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("FRED_KEY", raising=False)
    else:
        monkeypatch.setenv("FRED_KEY", value)

    def handler(request):
        raise AssertionError("no request may be made without a key")

    with pytest.raises(RuntimeError, match="FRED_KEY"):
        fetch_tbill(client_for(handler))


def assert_key_nowhere(err: BaseException) -> None:
    """The key must not be in the error's url, its message, or anything a traceback would print."""
    assert isinstance(err, FetchError)
    assert KEY not in err.url
    assert KEY not in str(err)
    assert KEY not in repr(err)
    assert KEY not in "".join(traceback.format_exception(err))
    assert "?" not in err.url


def test_http_error_does_not_leak_the_key():
    client = client_for(lambda request: httpx.Response(400, json={"error_message": "Bad Request"}))

    with pytest.raises(FetchError) as caught:
        fetch_tbill(client)

    err = caught.value
    assert_key_nowhere(err)
    assert err.url == FRED_URL
    assert err.status == 400


def test_network_error_does_not_leak_the_key():
    def handler(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")  # a message that echoes the url

    with pytest.raises(FetchError) as caught:
        fetch_tbill(client_for(handler))

    err = caught.value
    assert_key_nowhere(err)
    assert err.status is None
    assert "cannot reach" in str(err)  # the rest of the detail survives


def test_server_error_after_retries_does_not_leak_the_key():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503)

    with pytest.raises(FetchError) as caught:
        fetch_tbill(client_for(handler))

    assert len(calls) == 5  # the client retried before giving up
    assert_key_nowhere(caught.value)
    assert caught.value.status == 503


def test_redirect_to_a_url_with_the_key_does_not_leak_it():
    location = f"https://elsewhere.test/x?api_key={KEY}"
    client = client_for(lambda request: httpx.Response(302, headers={"location": location}))

    with pytest.raises(FetchError) as caught:
        fetch_tbill(client)

    assert_key_nowhere(caught.value)
    assert caught.value.status == 302


@pytest.mark.parametrize(
    "payload",
    [
        {"error_code": 400, "error_message": "Bad Request"},  # no observations
        {"observations": "none"},
        {"observations": [{"date": "2023-01-03"}]},
        {"observations": [{"date": "2023-01-03", "value": "n/a"}]},
        {"observations": [{"date": "2023-01-03", "value": "nan"}]},
        [],
    ],
)
def test_unexpected_response_is_a_fetch_error_without_the_key(payload):
    with pytest.raises(FetchError, match="unexpected response") as caught:
        fetch_tbill(serve(payload))

    assert_key_nowhere(caught.value)
    assert caught.value.status == 200


def test_non_json_response_is_a_fetch_error():
    client = client_for(lambda request: httpx.Response(200, text="<html>maintenance</html>"))

    with pytest.raises(FetchError, match="unexpected response") as caught:
        fetch_tbill(client)

    assert_key_nowhere(caught.value)
