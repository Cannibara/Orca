# Orca logo ("Lune")

Last verified: 2026-11-14

Proposed logo. Not wired into the site yet: the header in `web/src/App.tsx` and the favicon in `web/index.html` still use the placeholder.

## Idea
An orca breaking the surface, built from three shapes, all drawn with true circular arcs:
- **Crescent body**: circle C1 minus a larger circle C2. Its two horns are the tail and the jaw, and the hollow arc reads as the white belly.
- **Blade fin**: two arcs, a convex leading edge and a slightly concave trailing edge.
- **Lens eye patch**: a symmetric lens.

The fin tip and both horns share one fillet (r 0.76 on the 96 grid). The tall fin and the eye patch make it an orca, not a generic whale. The mark is one colour first. It matches the site's ink/paper tokens and Instrument Sans 600 wordmark.

## Files
| File | Use |
|---|---|
| `orca-mark.svg` | Symbol, `currentColor`, 96 box. Above 24 px |
| `orca-mark-16.svg` | Same silhouette, larger eye patch. 24 px and below (header 22 px, favicon) |
| `orca-lockup.svg` / `orca-lockup-stacked.svg` | Mark + outlined Instrument Sans 600 "Orca" (−0.02em), `currentColor` |
| `orca-icon.svg`, `icon-512.png` | App tile: ocean #267CAA, ink orca, paper eye patch |
| `favicon.svg` | 32 grid; ink on light tabs, #F3ECE3 on dark tabs (`prefers-color-scheme`) |
| `favicon-32.png`, `apple-touch-icon.png` | Raster fallbacks (blue tile; the touch icon is full-bleed, iOS rounds it) |
| `og-image.png` | 1200×630 social card |
| `brand-sheet.png` | Construction, clear space, minimum sizes, colourways, don'ts |

## Rules
- **Clear space:** 1X on every side, where X is the eye-patch length (about a quarter of the mark's height).
- **Minimum size:** the mark is 16 px (use the `-16` file at 24 px and below). The horizontal lockup is at least 56 px wide, the stacked lockup at least 40 px.
- **Colour:** ink #1B1916 on paper, or #F3ECE3 on ink. Ocean blue is only ever the icon field, never the orca itself.
- **Don't:** stretch, rotate, outline, recolour outside the palette, or re-set the wordmark in live text.
