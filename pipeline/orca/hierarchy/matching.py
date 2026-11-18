"""Match Orca's security names to a reference list of companies (Damodaran's global file).

Orca's `securities.json` carries Bloomberg-style names ("ALPHABET INC-CL C", "TAIWAN SEMICONDUCTOR-SP ADR",
"AMERICAN REALTY INVESTORS IN") and tickers that are often not the exchange ticker ("EXMOC", "8QR", "K4F"). So a
name is the key and a ticker only breaks ties. A name is cut to its distinctive words, then compared word by word
with allowance for truncation (MACHIN / MACHINES) and abbreviation (INTL / INTERNATIONAL). Standard library only.
"""

from __future__ import annotations

import collections
import math
import re
import unicodedata
from dataclasses import dataclass

US_EXCHANGES = frozenset({"NYSE", "NasdaqGS", "NasdaqGM", "NasdaqCM", "NYSEAM", "NYSEArca"})

# Words that say what kind of share or legal form a name is, not which company it is.
NOISE = frozenset(
    """INC INCORPORATED CORP CORPORATION CO COMPANY LTD LIMITED PLC LLC LP LLP NV SA AG SE SPA AB ASA OYJ BV NA THE
    COM ORD SHS ADR ADS SP SPON SPONS SPONSORED CLASS CL NEW COMMON STOCK DEL SHARES SHARE UNIT UNITS REDH REG REGD
    CDI PCL SAB DE CV KK TBK NPV DI GDR AND OF NY REGISTERED CLS""".split()
)
MIN_RARE = 0.63  # rarity a match must explain, in units of one word found nowhere else; BANCORP alone is about 0.4


def tokens(name: str, truncated: bool = False) -> list[str]:
    """The distinctive words of a company name, upper case, in order, without repeats.

    "N B T BANCORP INC" gives NBT and BANCORP; "S&T Bancorp" gives ST and BANCORP; "BP p.l.c." gives BP (PLC is
    noise); a lone letter (the class in "INC-CLASS A") is dropped. `truncated` is for a name cut at 28
    characters: its last word may be the start of a noise word ("... EXCHANGE IN"), which is dropped too.
    """
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()  # Estée → Estee
    text = re.sub(r"\([^)]*\)\s*$", " ", plain.upper().replace("&", " "))
    words = re.sub(r"[^A-Z0-9]+", " ", text).split()
    if truncated and words and len(words[-1]) <= 4 and any(w.startswith(words[-1]) for w in NOISE):
        words.pop()
    out: list[str] = []
    run = ""
    for word in [*words, ""]:  # the sentinel flushes the last run of single letters
        if len(word) == 1 and word.isalpha():
            run += word
            continue
        if len(run) > 1 and run not in NOISE:
            out.append(run)
        run = ""
        if word and word not in NOISE:
            out.append(word)
    return list(dict.fromkeys(out))


def abbreviates(a: str, b: str) -> bool:
    """True when `a` is a cut or an abbreviation of `b`: MACHIN/MACHINES, INTL/INTERNATIONAL, HLDGS/HOLDINGS."""
    if a == b:
        return True
    if len(a) < 3 or len(a) >= len(b) or a[0] != b[0]:
        return False
    if b.startswith(a):
        return True
    letters = iter(b)
    return all(c in letters for c in a)


@dataclass(frozen=True)
class Ref:
    """One company in the reference list."""

    name: str
    exchange: str
    ticker: str
    country: str
    group: str  # Damodaran industry group
    sic: str = ""

    @property
    def us(self) -> bool:
        return self.exchange in US_EXCHANGES


@dataclass(frozen=True)
class Candidate:
    ref: Ref
    score: float  # 0..1, blends how much of the Orca name and of the reference name is explained
    cover: float  # share of the Orca name's weight that the reference explains
    cover_ref: float  # share of the reference name's weight that the Orca name explains
    rare: float  # summed rarity of the words that matched (a word found nowhere else counts 1)
    ticker_equal: bool
    gap: float = 0.0  # lead over the runner-up

    @property
    def strong(self) -> bool:
        return self.cover >= 0.9 and self.cover_ref >= 0.6 and self.score >= 0.85 and self.rare >= MIN_RARE


def clean(ticker: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", ticker.upper())


class Matcher:
    def __init__(self, refs: list[Ref]) -> None:
        self.refs = refs
        self.toks = [tokens(r.name) for r in refs]
        df = collections.Counter(t for ts in self.toks for t in ts)
        n = len(refs)
        self._idf = {t: math.log((n + 1) / (c + 1)) + 0.3 for t, c in df.items()}
        self._unseen = math.log(n + 1) + 0.3
        self._by_head: dict[str, set[int]] = collections.defaultdict(set)
        self._by_ticker: dict[str, list[int]] = collections.defaultdict(list)
        for i, ts in enumerate(self.toks):
            for t in ts:
                self._by_head[t[:4]].add(i)
            self._by_ticker[clean(refs[i].ticker)].append(i)

    def idf(self, token: str) -> float:
        return self._idf.get(token, self._unseen)

    def _compare(self, a_tokens: list[str], b_tokens: list[str]) -> tuple[float, float, float]:
        if not b_tokens:
            return 0.0, 0.0, 0.0
        wa = sum(self.idf(a) for a in a_tokens)
        got = rare = 0.0
        used: set[int] = set()
        for a in a_tokens:
            best, at = 0.0, -1
            for j, b in enumerate(b_tokens):
                m = 1.0 if a == b else 0.85 if abbreviates(a, b) or abbreviates(b, a) else 0.0
                if m > best:
                    best, at = m, j
            if best:
                got += best * self.idf(a)
                rare += best * self.idf(a)
                used.add(at)
        wb = sum(self.idf(b) for b in b_tokens)
        return got / wa, sum(self.idf(b_tokens[j]) for j in used) / wb, rare

    def match(self, name: str, ticker: str = "", limit: int = 5) -> list[Candidate]:
        """The best reference companies for a name, best first. Empty when the name has no distinctive word."""
        a_tokens = tokens(name, truncated=len(name) >= 27)
        if not a_tokens:
            return []
        weight: collections.Counter[int] = collections.Counter()
        for a in a_tokens:
            bucket = self._by_head.get(a[:4], ())
            if len(bucket) <= 4000:  # a head shared by thousands (BANK, FIRS) says little
                for i in bucket:
                    weight[i] += self.idf(a)
        tick = clean(ticker)
        same_ticker = set(self._by_ticker.get(tick, ())) if tick else set()
        found: list[tuple[float, Candidate]] = []
        for i in {i for i, _ in weight.most_common(400)} | same_ticker:
            cover, cover_ref, rare = self._compare(a_tokens, self.toks[i])
            score = 0.65 * cover + 0.35 * cover_ref
            ref = self.refs[i]
            cand = Candidate(ref, round(score, 3), round(cover, 3), round(cover_ref, 3), round(rare / self._unseen, 2), i in same_ticker)
            rank = score + (0.1 if cand.ticker_equal else 0.0) + (0.02 if ref.us else 0.0)
            found.append((rank, cand))
        found.sort(key=lambda x: -x[0])
        if not found:
            return []
        out = [c for _, c in found[:limit]]
        lead = found[0][0] - (found[1][0] if len(found) > 1 else 0.0)
        out[0] = Candidate(*[getattr(out[0], f) for f in ("ref", "score", "cover", "cover_ref", "rare", "ticker_equal")], round(lead, 3))
        return out


def tier(best: Candidate | None) -> str:
    """How far to trust the best candidate.

    auto    strong name match to a US-listed company, or to one listed elsewhere under the same ticker (a Toronto
            or London cross-listing): label it from the hierarchy
    verify  strong match to a company listed elsewhere under another ticker (an ADR), or a partial one: a person
            or model should confirm
    none    nothing close: classify from the name
    """
    if best is None:
        return "none"
    if best.strong and (best.ref.us or best.ticker_equal):
        return "auto"
    if best.strong or (best.ticker_equal and best.cover >= 0.8) or best.score >= 0.7:
        return "verify"
    return "none"


def kind(ticker: str, published_sector: str) -> str:
    """What sort of security a row is, from fields Orca already publishes.

    etf     Orca's own "ETF/Fund" sector
    bond    a ticker with a coupon and a maturity date ("DOMINION RESOURCES 6 07-01-16"): a note or a bond
    fund    a mutual-fund ticker (four letters then X)
    stock   anything else; the name decides later whether it is an operating company
    """
    if published_sector == "ETF/Fund":
        return "etf"
    if " " in ticker and re.search(r"\d", ticker):
        return "bond"
    if re.fullmatch(r"[A-Z]{4}X", ticker):
        return "fund"
    return "stock"
