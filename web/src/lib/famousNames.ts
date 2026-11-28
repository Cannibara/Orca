// Hand-kept names for the home page's Famous funds chart (spec 3.3.6, 3.3.7, 3.4 and Appendix B).
// No contract change: these live in the web until the pipeline publishes short names.
import { fundShortName } from "./format";

/** Short names the rules in `fundShortName` cannot produce, by fund_id (all six periods' famous rows, 2026-11-21). */
export const SHORT_NAME: Record<number, string> = {
  921669: "Carl Icahn", // ICAHN CARL C
  1607841: "Sequoia Capital", // SC US (TTGP), LTD.
  1470766: "HongShan", // HSG Holding Ltd
  1740858: "DST Global", // Galileo (PTC) Ltd
  1166559: "Gates Foundation", // GATES FOUNDATION TRUST
  1305473: "Insight Partners", // Insight Holdings Group, LLC
  1548594: "Battery Ventures", // BATTERY MANAGEMENT CORP.
  1017918: "Baron Capital", // BAMCO INC /NY/
  850529: "Fisher Investments", // Fisher Asset Management, LLC
  898382: "Leon Cooperman", // COOPERMAN LEON G
  1656456: "Appaloosa", // APPALOOSA LP
  1035674: "Paulson & Co.", // PAULSON & CO. INC.
  1263508: "Baker Bros.", // BAKER BROS. ADVISORS LP
  1510387: "Gotham", // Gotham Asset Management, LLC
  1647251: "TCI", // TCI FUND MANAGEMENT LTD
  // Brands an all-caps filing name cannot be re-cased into.
  1537530: "Sequoia Global Equities", // SCGE MANAGEMENT, L.P.
  1053321: "OMERS", // OMERS ADMINISTRATION Corp
  1065521: "SoftBank", // SOFTBANK GROUP CORP.
  1018724: "Amazon", // AMAZON COM INC
  1055951: "OrbiMed", // ORBIMED ADVISORS LLC
  1745981: "WorldQuant Millennium", // WORLDQUANT MILLENNIUM ADVISORS LLC
  // Venture filers named by their legal vehicle: the brand plus the fund's vintage.
  1716997: "IVP XVI", // INSTITUTIONAL VENTURE MANAGEMENT XVI, LLC
  1640275: "IVP XV", // INSTITUTIONAL VENTURE MANAGEMENT XV, LLC
  1550304: "IVP XIV", // Institutional Venture Management XIV, LLC
  1493921: "IVP XIII", // Institutional Venture Management XIII, LLC
  1626282: "TCV VIII", // Technology Crossover Management VIII, Ltd.
  1977402: "TCV XI", // Technology Crossover Management XI, Ltd.
  1500599: "Kleiner Perkins XII", // KPCB XII Associates, LLC
  1546196: "Kleiner Perkins XIV", // KPCB XIV Associates, LLC
  1471126: "Sequoia Growth", // SCGF GENPAR LTD (Sequoia Capital Growth Fund)
  1463559: "AIMCo", // Alberta Investment Management Corp
  // Two filers of one brand in the same list: keep the brand plus what tells them apart.
  1600213: "Spark Capital II", // Spark Management Partners II, LLC
  1640445: "Spark Capital III", // Spark Management Partners III (AIV I), LLC
  1912628: "Ribbit Capital II", // Ribbit Capital GP II, Ltd.
  1697452: "Ribbit Capital IV", // Ribbit Capital GP IV, Ltd.
  1569205: "Fundsmith", // Fundsmith LLP
  1868537: "Fundsmith Investment", // FUNDSMITH INVESTMENT SERVICES LTD.
  1577133: "Greenwoods", // Greenwoods Asset Management Ltd
  1848138: "Greenwoods Hong Kong", // Greenwoods Asset Management Hong Kong Ltd.
  1627436: "Sylebra Capital Ltd", // Sylebra Capital Ltd
  2003074: "Sylebra Capital LLC", // SYLEBRA CAPITAL LLC
  // The Landscape's largest filers (2026-11-28): names the rules cut or case wrongly.
  315066: "Fidelity",
  19617: "JPMorgan Chase",
  861177: "UBS Asset Management",
  1390777: "BNY",
  1000275: "RBC",
  354204: "Dimensional",
  1214717: "Geode",
  748054: "American Century",
  720005: "Raymond James",
  948046: "Deutsche Bank",
  1109448: "AllianceBernstein",
  815917: "Edward Jones",
  927971: "BMO",
  912938: "MFS",
  1164508: "Arrowstreet",
  1141802: "Northwestern Mutual",
  919079: "CalPERS",
  1283718: "CPP Investments",
  869178: "VanEck",
  1009207: "D. E. Shaw",
  1086619: "Schroders",
  318989: "Fidelity International",
  315032: "State Farm",
  1115418: "RhumbLine",
  928047: "Manulife",
  1218210: "Nordea",
  1694217: "DZ Bank",
  720672: "Stifel",
  946431: "Swedbank",
  1666741: "Cetera",
  1056053: "TD Asset Management",
  1348883: "ClearBridge",
  1692234: "Russell Investments",
  350894: "SEI",
  1504492: "St. James Investment",
  1081019: "CalSTRS",
  1088875: "Baillie Gifford",
  1546007: "Assenagon",
  1729829: "Qube Research",
  1520354: "BNP Paribas AM",
  36104: "U.S. Bancorp",
  1018331: "Natixis Advisors",
  1456228: "Deka",
  916542: "Acadian",
  312348: "Loomis Sayles",
  312272: "Commonwealth",
  944388: "1832 Asset Management",
  813917: "Harris (Oakmark)",
  1037389: "Renaissance",
  810265: "NY State Common",
  1632972: "Wealth Enhancement",
  1357955: "ProShares",
  1165408: "Adage Capital",
  1512024: "CAPTRUST",
  898286: "CDPQ",
  938076: "Florida SBA",
  2057170: "Universal-Investment",
  1890906: "Allspring",
  35527: "Fifth Third",
  1046192: "Canada Life",
  1535845: "HOOPP",
  314984: "Thrivent",
  1344551: "AssetMark",
  1637460: "Man Group",
  1569395: "Mirae Asset Global Investments",
  314969: "NYSTRS",
  1441689: "Korea Investment Corp",
  1368163: "Zürcher Kantonalbank",
  854157: "SWIB",
  1466153: "Artisan Partners",
  1021926: "CIBC Asset Management",
  1642575: "Squarepoint",
  1352662: "GMO",
  1419186: "Cambridge Investment",
  1396318: "PSP Investments",
  1418329: "Ninety One",
  1978885: "Empower",
  937729: "Fayez Sarofim",
  1730073: "PFA Pension",
  902367: "William Blair",
  796848: "TRS Texas",
  1544599: "Julius Baer",
  1761054: "North Carolina Treasurer",
  2107286: "Eurizon",
  1191672: "Crédit Agricole",
  1398318: "Handelsbanken Fonder",
  937615: "NISA",
  2022297: "Desjardins",
  1608046: "National Pension Service (Korea)",
  1595888: "Jane Street",
  1475597: "Hudson River Trading",
};

/** Phone only: where the 136px name column is too narrow, keyed by the desktop short name. */
export const PHONE_SHORT: Record<string, string> = {
  "Duquesne Family Office": "Duquesne",
  "Pershing Square Capital": "Pershing Square",
  "Renaissance Technologies": "Renaissance",
  "Alaska Permanent Fund": "Alaska Fund",
  "Arizona State Retirement System": "Arizona ASRS",
  "Caisse de depot et placement du Quebec": "CDPQ",
  "California Public Employees Retirement System": "CalPERS",
  "California State Teachers Retirement System": "CalSTRS",
  "Canada Pension Plan Investment Board": "CPP Investments",
  "Darsana Capital Partners": "Darsana",
  "Durable Capital Partners": "Durable",
  "Employees Provident Fund Board": "Malaysia EPF",
  "Engineers Gate Manager": "Engineers Gate",
  "Greenwoods Hong Kong": "Greenwoods HK",
  "Hardman Johnston Global": "Hardman Johnston",
  "Healthcare of Ontario Pension Plan Trust Fund": "HOOPP",
  "Hengistbury Investment Partners": "Hengistbury",
  "Investment Management Corp of Ontario": "IMCO",
  "Kayne Anderson Rudnick": "Kayne Anderson",
  "Lighthouse Investment Partners": "Lighthouse",
  "Lightspeed Opportunity Fund": "Lightspeed",
  "National Pension Service": "Korea NPS",
  "New York State Common Retirement Fund": "NY State Common",
  "New York State Teachers Retirement System": "NY State Teachers",
  "Norwest Venture Partners XIII": "Norwest XIII",
  "Ontario Teachers Pension Plan Board": "Ontario Teachers",
  "Oregon Public Employees Retirement Fund": "Oregon PERF",
  "Pantera Capital Partners": "Pantera",
  "Perseverance Asset Management International": "Perseverance",
  "Public Employees Retirement System of Ohio": "Ohio OPERS",
  "Public Investment Fund": "Saudi PIF",
  "Public Sector Pension Investment Board": "PSP Investments",
  "Regeneron Pharmaceuticals": "Regeneron",
  "Ruane, Cunniff & Goldfarb": "Ruane Cunniff",
  "Sequoia Global Equities": "Sequoia Global",
  "Spark Growth Management Partners": "Spark Growth",
  "State Board of Administration of Florida Retirement System": "Florida SBA",
  "State of Michigan Retirement System": "Michigan Retirement",
  "State of New Jersey Common Pension Fund D": "NJ Pension Fund D",
  "State of Wisconsin Investment Board": "Wisconsin SWIB",
  "Teacher Retirement System of Texas": "Texas Teachers",
  "Treasurer of the State of North Carolina": "N. Carolina pension", // the state alone does not read as a fund
  "Virginia Retirement Systems": "Virginia Retirement",
  "WorldQuant Millennium": "WorldQuant",
};

/**
 * The line shown under a fund's name for every famous.csv `manager` that is not a plain person's name
 * (Appendix B). `null` = no line. The raw `manager` still picks the photo.
 */
export const MANAGER_LINE: Record<string, string | null> = {
  "8VC (Joe Lonsdale)": "Joe Lonsdale",
  "Abu Dhabi sovereign fund (Mubadala unit)": null,
  "Abu Dhabi sovereign investor": null,
  "Accel (Accel X)": null,
  "Accel (Accel XI)": null,
  "Accel (Growth Fund V)": null,
  "Accel (Leaders 4 growth fund)": null,
  "Alaska's oil fund": null,
  "Alberta's pension manager (AIMCo)": null,
  "Andreessen Horowitz (a16z)": null,
  "Arizona public pension": null,
  "Arnold Van Den Berg": "Arnold Van Den Berg",
  "Australia's largest super fund": null,
  "Australian public-sector super fund": null,
  "Australian universities' super fund": null,
  "BOND (Mary Meeker)": "Mary Meeker",
  "Bain Capital (Brookside)": null,
  "Battery Ventures": null,
  "Bessemer Venture Partners": null,
  "Bijan Modanlou & Jay Kodali (co-founders)": "Bijan Modanlou & Jay Kodali",
  "Bill Gates (Cascade)": "Bill Gates",
  "British Columbia's pension manager (BCI)": null,
  "CalPERS, largest US public pension": null,
  "CalSTRS, California teachers' pension": null,
  "Canaan Partners (VII)": null,
  "Canaan Partners (X)": null,
  "Canaan Partners (XI)": null,
  "Canada Pension Plan (CPP Investments)": null,
  "Canada's federal public-service pension (PSP)": null,
  "Cbus, Australian construction workers' super": null,
  "DST Global (Yuri Milner)": "Yuri Milner",
  "DST Global (Yuri Milner), early entity": "Yuri Milner",
  "DST Global / Yuri Milner trust vehicle": "Yuri Milner",
  "Denmark's national pension (ATP)": null,
  "Dutch civil servants' pension (ABP)": null,
  "Dutch healthcare workers' pension": null,
  "Felix & Julian Baker": "Felix & Julian Baker",
  "First Round Capital": null,
  "Founders Fund (Growth)": null,
  "Founders Fund (II)": null,
  "Founders Fund (IV)": null,
  "Founders Fund (VI)": null,
  "Founders Fund (VII)": null,
  "Foundry Group": null,
  "Foundry Group (Next)": null,
  "GGV Capital": null,
  "General Atlantic (growth equity)": null,
  "George Fraise / Gordon Marchand": "George Fraise & Gordon Marchand",
  "Google": null,
  "Greylock (15)": null,
  "Greylock (XI)": null,
  "Greylock (XII)": null,
  "Greylock (XIII)": null,
  "Greylock (XIV)": null,
  "Hamish Douglass (to 2022)": "Hamish Douglass",
  "HongShan (formerly Sequoia Capital China)": null,
  "IVP (XIII)": null,
  "IVP (XIV)": null,
  "IVP (XV)": null,
  "IVP (XVI)": null,
  "Index Ventures (III)": null,
  "Index Ventures (IV)": null,
  "Index Ventures (V)": null,
  "Insight Partners": null,
  "Irving Kahn (Graham's assistant)": "Irving Kahn",
  "Jerome Lande & Matt Sirovich": "Jerome Lande & Matt Sirovich",
  "John Overdeck & David Siegel": "John Overdeck & David Siegel",
  "John S. Clark II": "John S. Clark",
  "Kleiner Perkins (KPCB XII)": null,
  "Kleiner Perkins (KPCB XIII)": null,
  "Kleiner Perkins (KPCB XIV)": null,
  "Kleiner Perkins (KPCB XV)": null,
  "Kleiner Perkins Digital Growth Fund II": null,
  "Korea's national pension": null,
  "Korea's sovereign wealth fund": null,
  "Lightspeed Venture Partners (Opportunity Fund)": null,
  "Lou Simpson (GEICO)": "Lou Simpson",
  "Malaysia's national pension (EPF)": null,
  "Mark Arnold / Jason Orthman": "Mark Arnold & Jason Orthman",
  "Matrix Partners (VII)": null,
  "Matrix Partners (now Matrix)": null,
  "Mayfield (XII)": null,
  "Menlo Ventures": null,
  "Michael Rockefeller & Karl Kroeker": "Michael Rockefeller & Karl Kroeker",
  "Michigan public pensions": null,
  "Neil Shen (founder of HongShan / Sequoia China)": "Neil Shen",
  "New Enterprise Associates (NEA)": null,
  "New Jersey state pension (equity fund)": null,
  "New York State's pension fund": null,
  "New York teachers' pension": null,
  "Nick Sleep & Qais Zakaria": "Nick Sleep & Qais Zakaria",
  "North Carolina state pension": null,
  "Norway's largest pension company (KLP)": null,
  "Norway's oil fund": null,
  "Norwest Venture Partners (VIII)": null,
  "Norwest Venture Partners (XI)": null,
  "Norwest Venture Partners (XIII)": null,
  "Norwest Venture Partners (XIV)": null,
  "Notable Capital (formerly GGV Capital US)": null,
  "Novo Nordisk Foundation": null,
  "Ohio public employees' pension (OPERS)": null,
  "Ohio teachers' pension": null,
  "Ontario Teachers' Pension Plan": null,
  "Ontario hospital workers' pension (HOOPP)": null,
  "Ontario municipal workers' pension": null,
  "Ontario public pension manager (IMCO)": null,
  "Oregon public pension": null,
  "Pantera Capital (crypto)": null,
  "Paradigm (crypto VC)": null,
  "Paul Black / Mike Trigg": "Paul Black & Mike Trigg",
  "Paul Marshall & Ian Wace": "Paul Marshall & Ian Wace",
  "Paul Ruddock & Steven Heinz (founders)": "Paul Ruddock & Steven Heinz",
  "Peak XV Partners (formerly Sequoia Capital India)": null,
  "Phil Town (Rule #1)": "Phil Town",
  "Quebec's pension manager (CDPQ)": null,
  "Redpoint Ventures": null,
  "Ribbit Capital": null,
  "Ribbit Capital (GP II)": null,
  "Ribbit Capital (GP IV)": null,
  "Richard Rooney / Tony Arrell": "Richard Rooney & Tony Arrell",
  "Sam Isaly / Carl Gordon": "Sam Isaly & Carl Gordon",
  "Saudi Arabia's central bank (SAMA)": null,
  "Saudi Arabia's sovereign wealth fund": null,
  "Sequoia Capital (US Venture X)": null,
  "Sequoia Capital (US Venture XI)": null,
  "Sequoia Capital (US Venture XII)": null,
  "Sequoia Capital (US growth / TTGP)": null,
  "Sequoia Capital China public equities (HongShan)": null,
  "Sequoia Capital Global Equities": null,
  "Sequoia Capital Growth Fund (GenPar)": null,
  "Sequoia Capital Growth Fund III": null,
  "Sequoia Fund": "Bill Ruane",
  "Singapore's state investor": null,
  "Social Capital (Chamath Palihapitiya)": "Chamath Palihapitiya",
  "SoftBank Vision Fund (SB Investment Advisers)": null,
  "Spark Capital (Growth)": null,
  "Spark Capital (II)": null,
  "Spark Capital (III)": null,
  "Summit Partners (growth equity)": null,
  "Swedish state pension fund AP1": null,
  "Swedish state pension fund AP2": null,
  "Swedish state pension fund AP3": null,
  "Swedish state pension fund AP4": null,
  "Switzerland's central bank": null,
  "TCV (IX)": null,
  "TCV (VIII)": null,
  "TCV (X)": null,
  "TCV (XI)": null,
  "Ted Kellner (founder)": "Ted Kellner",
  "Texas teachers' pension": null,
  "Thrive Capital (Josh Kushner)": "Josh Kushner",
  "Tom Steyer / Andrew Spokes": "Tom Steyer & Andrew Spokes",
  "UK railway workers' pension (Railpen)": null,
  "UK universities' pension (USS)": null,
  "Union Square Ventures (2004 fund)": null,
  "Union Square Ventures (2008 fund)": null,
  "Union Square Ventures (Opportunity)": null,
  "Valor Equity Partners": null,
  "William von Mueffling": "William von Mueffling",
  "Wisconsin's pension manager (SWIB)": null,
};

export const shortNameOf = (fundId: number, name: string): string => SHORT_NAME[fundId] ?? fundShortName(name);

export const phoneNameOf = (short: string): string => PHONE_SHORT[short] ?? short;

// 2-3 capitalised words; letters (any script), dots, apostrophes and hyphens inside a word; no brackets, slashes, digits.
const PLAIN_NAME = /^\p{Lu}[\p{L}.'’-]*(?:\s\p{Lu}[\p{L}.'’-]*){1,2}$/u;

/** The manager line for a fund row: a mapped value, a plain person's name as is, else none. */
export function managerLine(manager: string | null | undefined, short: string): string | null {
  if (manager == null || manager === "") return null;
  if (Object.hasOwn(MANAGER_LINE, manager)) return MANAGER_LINE[manager] ?? null;
  if (!PLAIN_NAME.test(manager)) return null;
  return manager === short ? null : manager;
}
