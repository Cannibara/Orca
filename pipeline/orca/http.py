"""Rate-limited HTTP client with retries, used for every outbound request."""

import math
import os
import time
from collections.abc import Callable

import httpx

SEC_RATE_PER_SEC = 8.0  # SEC's fair-access limit is 10; 8 leaves room for its own counting
# OpenFIGI mapping limits: with a key 25 requests per 6 s and 100 jobs each, without 25 per minute
# and 10 jobs each.
FIGI_RATE_KEYED = 25 / 6
FIGI_RATE_ANON = 25 / 60
FIGI_JOBS_KEYED = 100
FIGI_JOBS_ANON = 10
# Tiingo: the paid plan allows about 10,000 requests an hour (2.8 a second); 2.5 stays under it.
# The environment variable TIINGO_RATE_PER_SEC overrides the default.
TIINGO_RATE_DEFAULT = 2.5
FRED_RATE_PER_SEC = 2.0  # a pipeline run makes one FRED request; this is a polite ceiling
REQUEST_TIMEOUT = 30.0  # seconds


class FetchError(Exception):
    """A request failed for good. `status` is None when no HTTP response was received."""

    def __init__(self, url: str, status: int | None, detail: str = ""):
        self.url = url
        self.status = status
        self.detail = detail
        shown = "network error" if status is None else f"HTTP {status}"
        message = f"{url}: {shown}"
        super().__init__(f"{message} ({detail})" if detail else message)


class Client:
    """GET / POST JSON at most `rate_per_sec` times a second, retrying transient failures.

    Retries network errors (a body that cannot be decoded counts as one), 429 and 5xx, sleeping
    2, 4, 8, 16 s (doubling) between tries.
    Any other non-2xx response (other 4xx, and 3xx: redirects are never followed) raises
    FetchError at once. `sleep` and `clock` are injectable so tests can run on a fake clock.
    """

    def __init__(
        self,
        rate_per_sec: float,
        headers: dict[str, str],
        transport: httpx.BaseTransport | None = None,
        max_retries: int = 4,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._rate = rate_per_sec
        self._max_retries = max_retries
        self._sleep = sleep
        self._clock = clock
        # Token bucket holding one token: the first request is immediate, later ones
        # wait until a token has refilled, so requests are spaced 1 / rate apart.
        self._tokens = 1.0
        self._last = clock()
        self._http = httpx.Client(headers=headers, transport=transport, timeout=REQUEST_TIMEOUT)

    def get(self, url: str, **params) -> httpx.Response:
        # Merge params into any query already in the url; passing params={} to httpx
        # would replace that query with nothing.
        return self._request("GET", str(httpx.URL(url).copy_merge_params(params)))

    def post_json(self, url: str, body: object) -> httpx.Response:
        return self._request("POST", url, json=body)

    def _wait_for_token(self) -> None:
        self._refill()
        if self._tokens < 1.0:
            self._sleep((1.0 - self._tokens) / self._rate)
            self._refill()
        self._tokens -= 1.0

    def _refill(self) -> None:
        now = self._clock()
        self._tokens = min(1.0, self._tokens + (now - self._last) * self._rate)
        self._last = now

    def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        for attempt in range(self._max_retries + 1):
            self._wait_for_token()
            try:
                response = self._http.request(method, url, **kwargs)
            except (httpx.TransportError, httpx.DecodingError) as err:
                failure = FetchError(url, None, str(err))
                failure.__cause__ = err
            else:
                status = response.status_code
                if 200 <= status < 300:
                    return response
                detail = ""
                if 300 <= status < 400:
                    # Redirects are not followed (hops would bypass the limiter and could
                    # leak our headers to another host), so surface where it pointed.
                    location = response.headers.get("location", "<no Location header>")
                    detail = f"redirected to {location}; redirects are not followed"
                failure = FetchError(url, status, detail)
                if status != 429 and status < 500:
                    raise failure
            if attempt == self._max_retries:
                raise failure
            self._sleep(2 ** (attempt + 1))
        raise AssertionError("unreachable")  # the loop always returns or raises


def sec_client(
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Client:
    """Client for sec.gov: 8 requests/s and a User-Agent naming ORCA_CONTACT (SEC requires one).

    Create it once and share it: www.sec.gov and data.sec.gov count against one SEC rate
    limit, so every SEC request must go through the same Client.
    """
    contact = os.environ.get("ORCA_CONTACT", "").strip()
    if not contact:
        raise RuntimeError(
            "ORCA_CONTACT is not set. SEC requires a contact in the User-Agent; "
            "set ORCA_CONTACT to an email address or URL."
        )
    return Client(
        SEC_RATE_PER_SEC,
        {"User-Agent": f"Orca research {contact}"},
        transport=transport,
        sleep=sleep,
        clock=clock,
    )


class FigiClient(Client):
    """Client for OpenFIGI. `jobs_per_request` is how many mapping jobs one POST may carry."""

    def __init__(self, *args, jobs_per_request: int, **kwargs):
        super().__init__(*args, **kwargs)
        self.jobs_per_request = jobs_per_request


def figi_client(
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> FigiClient:
    """Client for OpenFIGI, limited to what the key allows.

    With OPENFIGI_KEY set: 25 requests per 6 s, 100 jobs per request, key sent as
    X-OPENFIGI-APIKEY. Without it: 25 requests per minute, 10 jobs per request.
    """
    key = os.environ.get("OPENFIGI_KEY", "").strip()
    if key:
        return FigiClient(
            FIGI_RATE_KEYED,
            {"X-OPENFIGI-APIKEY": key},
            transport=transport,
            sleep=sleep,
            clock=clock,
            jobs_per_request=FIGI_JOBS_KEYED,
        )
    return FigiClient(
        FIGI_RATE_ANON,
        {},
        transport=transport,
        sleep=sleep,
        clock=clock,
        jobs_per_request=FIGI_JOBS_ANON,
    )


def tiingo_client(
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Client:
    """Client for Tiingo. TIINGO_KEY goes out as `Authorization: Token <key>`, never in the URL
    (URLs end up in FetchError messages). Requests per second: TIINGO_RATE_PER_SEC if set (a
    positive number), else 2.5."""
    key = os.environ.get("TIINGO_KEY", "").strip()
    if not key:
        raise RuntimeError("TIINGO_KEY is not set. Set it to your Tiingo API token.")
    return Client(
        _tiingo_rate(),
        {"Authorization": f"Token {key}"},
        transport=transport,
        sleep=sleep,
        clock=clock,
    )


def _tiingo_rate() -> float:
    raw = os.environ.get("TIINGO_RATE_PER_SEC", "").strip()
    if not raw:
        return TIINGO_RATE_DEFAULT
    try:
        rate = float(raw)
    except ValueError:
        rate = math.nan
    if not math.isfinite(rate) or rate <= 0:
        raise RuntimeError(f"TIINGO_RATE_PER_SEC must be a positive number, got {raw!r}")
    return rate


def fred_client(
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Client:
    """Client for FRED: 2 requests/s, no headers. FRED takes its key only as a query parameter,
    so the caller adds it to each request (see `orca.rf.fetch_tbill`)."""
    return Client(FRED_RATE_PER_SEC, {}, transport=transport, sleep=sleep, clock=clock)
