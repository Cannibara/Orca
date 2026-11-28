"""Who each 13F filer is: hedge fund, asset manager, bank, pension fund, ... (the home page's Landscape tree
map). A 13F says nothing about its filer's kind, so every filer gets a type here, the first that applies:

1. investor_types.csv, kept by hand: the largest filers (holding companies, banks, pensions and sovereign
   funds are not in the SEC's adviser register) and any correction.
2. famous.csv: a famous fund's style list is its hedge fund style (Macro, Activists, ...), unless the adviser
   register says it is no hedge fund (a mutual fund firm in Value stays a mutual fund firm); Venture capital,
   Family offices, Big companies and Sovereign & pension funds name their own types.
3. An ETF firm by its name ("Defiance ETFs"); else investor_types_adv.csv, made by scripts/investor_types.py from the SEC's monthly adviser register (Form
   ADV): an adviser's type from whose money it runs (individuals: a wealth manager; mutual funds; pooled
   vehicles: a hedge, private equity or venture fund by the private funds it reports; institutions).
4. The SEC's industry code of the filer (fund_about `sic`): banks, brokers, insurers, and operating companies
   (Nvidia, Alphabet), whose code is not a financial one.
5. Words of the filer's name ("RETIREMENT SYSTEM", "UNIVERSITY", "FAMILY OFFICE", "BANCORP", ...).
6. Otherwise "other" (not yet classified).

Only leaves are assigned; TYPES gives each its parent for the tree map."""

import csv
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from orca.famous import Famous

HAND_CSV = Path(__file__).with_name("investor_types.csv")
ADV_CSV = Path(__file__).with_name("investor_types_adv.csv")
PARENTS_CSV = Path(__file__).with_name("investor_parents.csv")


@dataclass(frozen=True, slots=True)
class InvestorType:
    key: str
    label: str
    parent: str | None  # None: a top-level type


# The tree map's hierarchy, in display order within each level (the map itself orders by size). A type
# with children is a group; the others are leaves, the only types a filer is given.
TYPES = (
    InvestorType("hedge", "Hedge funds", None),
    InvestorType("hedge.ls", "Fundamental long/short", "hedge"),
    InvestorType("hedge.tiger", "Tiger cubs", "hedge"),
    InvestorType("hedge.buffett", "Buffett inspired", "hedge"),
    InvestorType("hedge.moat", "Moat investing", "hedge"),
    InvestorType("hedge.value", "Value", "hedge"),
    InvestorType("hedge.tech", "Tech & growth", "hedge"),
    InvestorType("hedge.health", "Healthcare specialists", "hedge"),
    InvestorType("hedge.activist", "Activists", "hedge"),
    InvestorType("hedge.macro", "Macro", "hedge"),
    InvestorType("hedge.credit", "Credit & event-driven", "hedge"),
    InvestorType("hedge.quant", "Quant & multi-strategy", "hedge"),
    InvestorType("hedge.other", "Other hedge funds", "hedge"),
    InvestorType("am", "Asset managers", None),
    InvestorType("am.etf", "ETF providers", "am"),
    InvestorType("am.mutual", "Mutual funds", "am"),
    InvestorType("am.inst", "Institutional managers", "am"),
    InvestorType("am.wealth", "Wealth managers", "am"),
    InvestorType("bank", "Banks & brokers", None),
    InvestorType("ins", "Insurers", None),
    InvestorType("pension", "Pension funds", None),
    InvestorType("swf", "Sovereign wealth & central banks", None),
    InvestorType("endow", "Endowments & foundations", None),
    InvestorType("family", "Family offices", None),
    InvestorType("pevc", "Private equity & VC", None),
    InvestorType("pevc.pe", "Private equity", "pevc"),
    InvestorType("pevc.vc", "Venture capital", "pevc"),
    InvestorType("corp", "Companies", None),
    InvestorType("other", "Not yet classified", None),
)
BY_KEY = {t.key: t for t in TYPES}
LEAVES = frozenset(t.key for t in TYPES if not any(c.parent == t.key for c in TYPES))
OTHER = "other"

# famous.csv's style lists: the hedge fund style each one is (step 2), or the type it names.
FAMOUS_STYLE = {
    "Buffett inspired": "hedge.buffett",
    "Moat investing": "hedge.moat",
    "Value": "hedge.value",
    "Tiger cubs": "hedge.tiger",
    "Fundamental long/short": "hedge.ls",
    "Healthcare specialists": "hedge.health",
    "Tech & growth": "hedge.tech",
    "Activists": "hedge.activist",
    "Macro": "hedge.macro",
    "Credit & event-driven": "hedge.credit",
    "Quant & multi-strategy": "hedge.quant",
}
FAMOUS_TYPE = {"Venture capital": "pevc.vc", "Family offices": "family", "Big companies": "corp"}
SOVEREIGN_AND_PENSION = "Sovereign & pension funds"
_SOV_OR_PENSION = "swf|pension"  # decided by the filer's name in `type_of`
# famous.csv's description of a Sovereign & pension funds row that names a pension ("Dutch healthcare workers'
# pension" for PGGM, "Australia's largest super fund"): many such filers' names carry no pension word.
_PENSION_NOTE = re.compile(r"pension|retirement|super fund|teachers", re.IGNORECASE)


def load_types(path: Path) -> dict[int, str]:
    """A types csv (fund_id, type, ...) as fund_id -> type; empty when the file is missing. Raises
    ValueError on a type that is no leaf of TYPES or a fund listed twice, so a bad edit fails the tests."""
    if not path.exists():
        return {}
    out: dict[int, str] = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            raw = (r.get("fund_id") or "").strip()
            if not raw or raw.startswith("#"):
                continue
            fund_id, kind = int(raw), (r.get("type") or "").strip()
            if kind not in LEAVES:
                raise ValueError(f"{path.name}: fund {fund_id} has type {kind!r}, not a leaf of TYPES")
            if fund_id in out:
                raise ValueError(f"{path.name} lists fund {fund_id} twice")
            out[fund_id] = kind
    return out


def load_parents(path: Path = PARENTS_CSV) -> dict[int, str]:
    """investor_parents.csv as fund_id -> the firm it files for (Vanguard's ten filers -> "Vanguard"); empty
    when the file is missing. Raises ValueError on a fund listed twice or an empty firm name."""
    if not path.exists():
        return {}
    out: dict[int, str] = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            raw = (r.get("fund_id") or "").strip()
            if not raw or raw.startswith("#"):
                continue
            fund_id, parent = int(raw), (r.get("parent") or "").strip()
            if not parent:
                raise ValueError(f"{path.name}: fund {fund_id} has no parent")
            if fund_id in out:
                raise ValueError(f"{path.name} lists fund {fund_id} twice")
            out[fund_id] = parent
    return out


# After the type: a hedge fund the steps could not give a style gets one from what it holds (refine_hedge).
SPECIALIST_SHARE = 0.6  # of the book in one sector: a healthcare or a tech & growth specialist
QUANT_POSITIONS = 400  # priced positions: a fundamental stock picker holds far fewer (multi-manager pods, quants)
_TECH_SECTORS = ("Tech", "Communication")


def refine_hedge(kind: str, weights: Mapping[int, float], n_priced: int, sector: Mapping[int, str]) -> str:
    """A style for an "Other hedge funds" filer from its holdings now: 60%+ of the book in health care, or in
    tech and communication, makes a specialist; 400+ priced positions a quant or multi-strategy fund. Any
    other type comes back as it is."""
    if kind != "hedge.other":
        return kind
    health = sum(w for sid, w in weights.items() if sector.get(sid) == "Health care")
    tech = sum(w for sid, w in weights.items() if sector.get(sid) in _TECH_SECTORS)
    if health >= SPECIALIST_SHARE:
        return "hedge.health"
    if tech >= SPECIALIST_SHARE:
        return "hedge.tech"
    if n_priced >= QUANT_POSITIONS:
        return "hedge.quant"
    return kind


# Step 5: a word of the name. Order matters: "Swiss National Bank" is a central bank before it is a bank,
# "Teachers Insurance" an insurer before a pension.
def _words(*alts: str) -> re.Pattern:
    return re.compile(r"(?<![A-Z0-9])(?:" + "|".join(alts) + r")(?![A-Z0-9])")


NAME_RULES: tuple[tuple[re.Pattern, str], ...] = (
    (_words("CENTRAL BANK", "MONETARY AUTHORITY", "INVESTMENT AUTHORITY", "SOVEREIGN", "NORGES BANK",
            "SWISS NATIONAL BANK", "BANK OF ISRAEL", "BANK OF KOREA", "BANK OF JAPAN", "RESERVE BANK"), "swf"),
    (_words("INSURANCE", "ASSURANCE", "ASSURANCES", "REINSURANCE", "CASUALTY", "MUTUAL LIFE",
            "LIFE INSURANCE", "VERSICHERUNG\\w*"), "ins"),
    (_words("PENSION\\w*", "RETIREMENT SYSTEM", "RETIREMENT SYSTEMS", "RETIREMENT FUND", "RETIREMENT BOARD",
            "RETIREMENT PLAN", "RETIREMENT ASSOCIATION", "TEACHERS", "PUBLIC EMPLOYEES", "SUPERANNUATION",
            "INVESTMENT BOARD", "STATE BOARD OF ADMINISTRATION", "COMMON RETIREMENT", "EMPLOYEES RETIREMENT",
            "PUBLIC SCHOOL", "MUNICIPAL EMPLOYEES", "FIREFIGHTERS", "POLICE", "PROVIDENT FUND"), "pension"),
    (_words("UNIVERSITY", "UNIVERSITIES", "COLLEGE", "ENDOWMENT", "FOUNDATION", "BOARD OF REGENTS",
            "INSTITUTE OF TECHNOLOGY", "TRUSTEES OF", "CHARITABLE", "SCHOOLS?"), "endow"),
    (_words("FAMILY OFFICES?", "FAMILY INVESTMENT OFFICE"), "family"),
    (_words("TRUST CO", "TRUST COMPANY", "WEALTH", "PRIVATE CLIENT", "PRIVATE CLIENTS", "FINANCIAL PLANNING",
            "FINANCIAL ADVISORS", "FINANCIAL ADVISERS", "RETIREMENT PLANNING", "FAMILY WEALTH"), "am.wealth"),
    (_words("BANK", "BANKS", "BANKERS", "BANCORP", "BANCORPORATION", "BANCSHARES", "BANKSHARES", "BANKING", "BANQUE",
            "SAVINGS", "NATIONAL ASSOCIATION", "BANCO", "SPARKASSE"), "bank"),
    (_words("VENTURE", "VENTURES"), "pevc.vc"),
    (_words("PRIVATE EQUITY"), "pevc.pe"),
)

# Before the adviser register: an ETF firm says so in its name (Defiance ETFs, Tema ETFs); the register
# would call it a mutual fund firm.
_ETF = re.compile(r"(?<![A-Z0-9])ETFS?(?![A-Z0-9])")

# Step 4: the SEC's industry description (sicDescription). A financial one is no operating company.
_SIC_BANK = re.compile(r"BANK|SAVINGS INSTITUTION|SECURITY BROKERS|SECURITY & COMMODITY BROKERS|COMMODITY CONTRACTS")
_SIC_INSURER = re.compile(r"INSURANCE|SURETY|HOSPITAL & MEDICAL SERVICE PLANS")
_SIC_FINANCE = re.compile(
    r"CREDIT|MORTGAGE|LOAN|FINANCE|ASSET-BACKED|SECURIT|COMMODIT|INVESTMENT|INVESTORS|REAL ESTATE|BLANK CHECK"
    r"|ROYALTY|PATENT OWNERS|UNIT INV|TRUST|DEPOSITORY|OPEN-END|MANAGEMENT INVESTMENT|NONCLASSIFIABLE"
)


def from_sic(sic: str | None) -> str | None:
    """The type an SEC industry description says: a bank or broker, an insurer, or (any non-financial
    industry) a company; None for other financial ones (investment advice says nothing) or none."""
    if not sic or not sic.strip():
        return None
    s = sic.upper()
    if _SIC_BANK.search(s):
        return "bank"
    if _SIC_INSURER.search(s):
        return "ins"
    if _SIC_FINANCE.search(s):
        return None
    return "corp"


def from_name(name: str) -> str | None:
    """The type a word of the filer's name says (NAME_RULES, first match), None when none does."""
    upper = name.upper().replace("&", " AND ")
    for pattern, kind in NAME_RULES:
        if pattern.search(upper):
            return kind
    return None


def famous_types(famous: Sequence[Famous], adv: Mapping[int, str]) -> dict[int, str]:
    """fund_id -> type from the famous lists (step 2). A fund in two lists takes its first in famous.csv. A
    style list is a hedge fund style unless the adviser register calls the fund an asset manager (it says
    "mutual funds" for Dodge & Cox; a hedge fund's private equity sidecars do not count against it); Sovereign & pension funds is split by the
    list's description (a pension word: a pension fund), else by the filer's name when it is classified (a
    pension word: a pension fund; else sovereign)."""
    out: dict[int, str] = {}
    for f in famous:
        if f.fund_id in out:
            continue
        if f.group in FAMOUS_STYLE:
            known = adv.get(f.fund_id)
            if known is not None and known.startswith("am."):
                continue  # the register's type stands (step 3): Dodge & Cox runs mutual funds
            out[f.fund_id] = FAMOUS_STYLE[f.group]
        elif f.group in FAMOUS_TYPE:
            out[f.fund_id] = FAMOUS_TYPE[f.group]
        elif f.group == SOVEREIGN_AND_PENSION:
            out[f.fund_id] = "pension" if _PENSION_NOTE.search(f.manager) else _SOV_OR_PENSION
    return out


@dataclass(frozen=True, slots=True)
class Classifier:
    """The steps' inputs: hand labels, the famous lists' types and the adviser register's."""

    hand: Mapping[int, str]
    famous: Mapping[int, str]
    adv: Mapping[int, str]

    def type_of(self, fund_id: int, name: str, sic: str | None = None) -> tuple[str, str]:
        """(type, how): how is the step that decided it: hand, famous, adv, sic, name or none."""
        for how, table in (("hand", self.hand), ("famous", self.famous), ("adv", self.adv)):
            if how == "adv" and _ETF.search(name.upper()):
                return "am.etf", "name"
            if fund_id in table:
                kind = table[fund_id]
                if kind == _SOV_OR_PENSION:
                    kind = "pension" if from_name(name) == "pension" else "swf"
                return kind, how
        kind = from_sic(sic)
        if kind is not None:
            return kind, "sic"
        kind = from_name(name)
        if kind is not None:
            return kind, "name"
        return OTHER, "none"


def load_classifier(famous: Sequence[Famous] = ()) -> Classifier:
    """The classifier a run uses: investor_types.csv, famous.csv's lists and investor_types_adv.csv."""
    adv = load_types(ADV_CSV)
    return Classifier(hand=load_types(HAND_CSV), famous=famous_types(famous, adv), adv=adv)
