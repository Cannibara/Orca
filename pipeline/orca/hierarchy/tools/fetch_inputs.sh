#!/usr/bin/env bash
# Downloads the three public inputs the hierarchy tools read into DIR. None of them is committed:
# each has its own terms (see ../README.md, "Data sources and licences").
set -euo pipefail
dir="${1:?usage: fetch_inputs.sh DIR}"
mkdir -p "$dir"
ua="Mozilla/5.0 (X11; Linux x86_64) orca-hierarchy-research"
# Damodaran: US companies with industry group, SIC code and exchange:ticker (updated each January).
curl -fsS -A "$ua" -o "$dir/indname.xlsx" "https://pages.stern.nyu.edu/~adamodar/pc/datasets/indname.xlsx"
# Nasdaq screener: market caps, used only to rank and size stocks in the review. Non-commercial terms.
curl -fsS -A "$ua" -H "Accept: application/json" -o "$dir/screener.json" \
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true"
# WRDS macro page with the Fama-French 48 SIC ranges: a cross-check label, not used for scoring.
curl -fsS -A "$ua" -o "$dir/ffi48.html" "https://wrds-www.wharton.upenn.edu/pages/wrds-research/macros/wrds-macros-ffi48/"
ls -l "$dir"
