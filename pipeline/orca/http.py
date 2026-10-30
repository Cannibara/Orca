"""Rate-limited HTTP client with retries, used for every outbound request."""

import os
import time
from collections.abc import Callable

import httpx

SEC_RATE_PER_SEC = 10.0  # SEC fair-access limit
REQUEST_TIMEOUT = 30.0  # seconds


class FetchError(Exception):
    """A request failed for good. `status` is None when no HTTP response was received."""

    def __init__(self, url: str, status: int | None, detail: str = ""):
        self.url = url
        self.status = status
        shown = "network error" if status is None else f"HTTP {status}"
        message = f"{url}: {shown}"
        super().__init__(f"{message} ({detail})" if detail else message)


class Client:
    """GET / POST JSON at most `rate_per_sec` times a second, retrying transient failures.

    Retries network errors, 429 and 5xx, sleeping 2, 4, 8, 16 s (doubling) between tries.
    Other 4xx responses raise FetchError at once. `sleep` and `clock` are injectable so
    tests can run on a fake clock.
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
        return self._request("GET", url, params=params)

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
            except httpx.TransportError as err:
                failure = FetchError(url, None, str(err))
                failure.__cause__ = err
            else:
                status = response.status_code
                if status < 400:
                    return response
                failure = FetchError(url, status)
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
    """Client for sec.gov: 10 requests/s and a User-Agent naming ORCA_CONTACT (SEC requires one)."""
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
