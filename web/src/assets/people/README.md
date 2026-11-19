# Photos of the people behind the famous funds

Shown as a round photo before the fund name on the Famous funds lists (home page).

## Replace or add a photo yourself

1. Find the file name: lower case, words joined by hyphens, from the name shown under the fund.
   Warren Buffett → `warren-buffett.jpg`. The full list is the files in this folder.
2. Upload your image with that exact name (GitHub: this folder → Add file → Upload files; same name replaces it).
   JPG, PNG or WEBP all work (`warren-buffett.png` is fine). Do not keep two files with the same name and different endings.
3. Square-ish and about 200–400 px is plenty; the site crops it to a circle, face toward the top.
4. Merge to `main`; the site rebuilds and shows it.

A person whose name differs from the text shown (two names under one fund, say) is matched through `people.json`
(text under the fund name → file name without the ending). Add a line there if a new photo does not appear.

## Credits

`credits.json` holds who took each photo and its licence; the site lists them on `/photo-credits`.
Photos came from Wikimedia Commons (public domain, CC0, CC BY, CC BY-SA); several licences require that credit.
**If you replace a photo, delete its entry in `credits.json`** (or edit it to your own details), or the page keeps the old photographer's name.
A photo with no entry gets no credit line.

## Fetch more automatically

New famous funds in `pipeline/orca/famous.csv` get photos with:

```
cd pipeline && uv run --with pillow --with opencv-python-headless==4.10.0.84 python scripts/fetch_people_images.py
```

It skips anyone who already has a file here, so photos you replaced by hand are kept. `--refresh` fetches everyone again.
People it cannot find a free photo for are listed at the end; they show no picture.
