// The famous funds' style lists, shared by the home page (its Famous funds tab) and the fund page (the
// "What kind of investor?" map, whose peers are the funds of the same list).

/**
 * The famous funds' styles, in page order (pipeline/orca/famous.py FAMOUS_GROUPS), each with a line about it.
 * A group the pipeline publishes that is not here is listed last, without a line.
 */
export const FAMOUS_GROUPS: { name: string; about: string }[] = [
  {
    name: "Buffett inspired",
    about:
      'Berkshire Hathaway and the investors closest to Buffett: friends, partners, disciples and "baby Berkshires".',
  },
  {
    name: "Moat investing",
    about:
      "Concentrated owners of a few great businesses with lasting advantages, held for years.",
  },
  { name: "Value", about: "Value investors: good companies bought cheap." },
  {
    name: "Tiger cubs",
    about:
      "Julian Robertson's Tiger Management and the funds its alumni started or it seeded (cubs and grand-cubs).",
  },
  {
    name: "Fundamental long/short",
    about:
      "Stock pickers who also bet against stocks. The 13F shows only what they own, not their bets against.",
  },
  {
    name: "Healthcare specialists",
    about:
      "Funds that invest only in healthcare and biotech, often backing drug makers before and after their trial results.",
  },
  { name: "Tech & growth", about: "Growth investors focused on technology." },
  {
    name: "Venture capital",
    about:
      "Venture firms. Their 13F shows only listed stakes, mostly companies they backed before the IPO.",
  },
  {
    name: "Activists",
    about: "Investors who buy big stakes to push companies to change.",
  },
  {
    name: "Macro",
    about:
      "Macro funds. The 13F shows only their US stocks, not their bonds, currencies or futures.",
  },
  {
    name: "Credit & event-driven",
    about:
      "Credit, distressed-debt and event-driven funds. The 13F shows only their listed shares, not their bonds or loans.",
  },
  {
    name: "Family offices",
    about:
      "Star traders and billionaires investing their own fortunes, mostly in stocks.",
  },
  {
    name: "Quant & multi-strategy",
    about: "Quant and multi-manager firms with large, fast-trading books.",
  },
  {
    name: "Big companies",
    about:
      "Companies investing their own money, like Google in SpaceX. A 13F shows only listed shares, so a stake shows up once the company lists.",
  },
  {
    name: "Sovereign & pension funds",
    about:
      "Countries' wealth funds, central banks and big pension and superannuation funds.",
  },
];
