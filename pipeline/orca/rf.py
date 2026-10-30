"""Risk-free rate: the yearly average of the 3-month Treasury bill (FRED series DTB3)."""

import math
import os
from collections import defaultdict
from urllib.parse import quote

from orca.http import Client, FetchError

FRED_URL = "https://api.stlouisfed.org/fred/series/observations"
SERIES = "DTB3"  # 3-month Treasury bill, secondary market rate, daily, in percent
START = "2013-01-01"


def fetch_tbill(client: Client) -> dict[int, float]:
    """The average DTB3 rate of each year since 2013, as a decimal (4.5 percent is 0.045), keyed
    by year. Days without a rate (FRED marks them ".") are skipped, and a year with none is
    absent. `client` comes from `fred_client()`; the key is read from FRED_KEY here.

    FRED accepts the key only as a query parameter, which would put it in the url of every
    FetchError. So a failure is re-raised with the query string removed from its url and the key
    removed from its detail; the original error is not chained, as its traceback would print the
    key."""
    key = os.environ.get("FRED_KEY", "").strip()
    if not key:
        raise RuntimeError("FRED_KEY is not set. Set it to your FRED API key.")
    try:
        response = client.get(
            FRED_URL, series_id=SERIES, file_type="json", observation_start=START, api_key=key
        )
    except FetchError as err:
        failure = FetchError(err.url.split("?")[0], err.status, _without_key(err.detail, key))
    else:
        failure = None
    if failure is not None:  # raised outside the except block so that it carries no context
        raise failure
    try:
        return _yearly_average(response.json()["observations"])
    except (KeyError, TypeError, ValueError) as err:
        raise FetchError(FRED_URL, response.status_code, f"unexpected response: {err!r}") from err


def _without_key(text: str, key: str) -> str:
    for form in {key, quote(key, safe="")}:
        text = text.replace(form, "***")
    return text


def _yearly_average(observations: list[dict]) -> dict[int, float]:
    """Each observation is {"date": "2023-01-03", "value": "4.32"}; "." means no rate that day."""
    if not isinstance(observations, list):
        raise TypeError(f"expected a list of observations, got {type(observations).__name__}")
    by_year: dict[int, list[float]] = defaultdict(list)
    for observation in observations:
        if observation["value"] == ".":
            continue
        percent = float(observation["value"])
        if not math.isfinite(percent):
            raise ValueError(f"rate {observation['value']!r} on {observation['date']}")
        by_year[int(observation["date"][:4])].append(percent)
    return {year: sum(rates) / len(rates) / 100 for year, rates in by_year.items()}
