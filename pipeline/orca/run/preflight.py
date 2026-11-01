"""One cheap request to each keyed service (OpenFIGI, Tiingo, FRED) before a run spends an hour on
the SEC bulk files, so a wrong or inactive key fails the run in seconds and names its secret.
Nothing this prints holds a key, or a URL that carries one."""

from collections.abc import Callable
from dataclasses import dataclass

from orca.http import FetchError, figi_client, fred_client, tiingo_client
from orca.rf import fetch_tbill
from orca.securities import FIGI_URL

PROBE_CUSIP = "78462F103"  # SPDR S&P 500 ETF (SPY), the benchmark
TIINGO_META_URL = "https://api.tiingo.com/tiingo/daily/SPY"


@dataclass(frozen=True)
class Probe:
    """`call` makes the test request; it raises FetchError (or RuntimeError when the key is not
    set) if the service refuses it. `where` says where the owner finds the key."""

    secret: str
    service: str
    where: str
    call: Callable[[], None]


def check_keys(probes: list[Probe]) -> list[str]:
    """Run every probe; one message per failed one, naming the secret and the HTTP status."""
    problems = []
    for probe in probes:
        try:
            probe.call()
        except RuntimeError:
            problems.append(f"{probe.secret} is not set. Add it as a secret of the environment.")
        except FetchError as err:
            problems.append(_explain(probe, err.status))
    return problems


def _explain(probe: Probe, status: int | None) -> str:
    if status is None:
        return f"{probe.service} could not be reached (network error); {probe.secret} is untested."
    if status in (400, 401, 403):
        return (
            f"{probe.service} refused {probe.secret} (HTTP {status}): the key is wrong or not "
            f"active. Copy it again from {probe.where} into the secret {probe.secret}."
        )
    return (
        f"{probe.service} answered a test request with {probe.secret} with HTTP {status}; if "
        f"this repeats, copy the key again from {probe.where}."
    )


def _openfigi() -> None:
    answer = figi_client().post_json(FIGI_URL, [{"idType": "ID_CUSIP", "idValue": PROBE_CUSIP}])
    jobs = answer.json()
    if not isinstance(jobs, list) or len(jobs) != 1 or not jobs[0].get("data"):
        raise FetchError(FIGI_URL, answer.status_code, "the test CUSIP was not mapped")


def production_probes() -> list[Probe]:
    return [
        Probe("OPENFIGI_KEY", "OpenFIGI", "openfigi.com (sign in, then API Key)", _openfigi),
        Probe(
            "TIINGO_KEY",
            "Tiingo",
            "tiingo.com (Account, then API, then Token)",
            lambda: tiingo_client().get(TIINGO_META_URL),
        ),
        Probe(
            "FRED_KEY",
            "FRED",
            "fredaccount.stlouisfed.org/apikeys",
            lambda: fetch_tbill(fred_client()),
        ),
    ]
