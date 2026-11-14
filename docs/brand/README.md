# Orca logo ("Lune")

Last verified: 2026-11-14

The official logo (v1.1, approved by the owner 2026-11-14). The website uses the black-and-white mark in its header (`web/src/App.tsx`, the `-16` cut inline), and the favicon files and `og-image.png` copied into `web/public/`. `brand-sheet.png` is the full guide as an image.

## Idea
An orca breaking the surface, built from three shapes, every curve a circular arc:
- **Crescent body**: circle C1 minus a larger circle C2. The two horns are the tail and the jaw; the hollow arc reads as the white belly.
- **Short fin**: wide and swept back, with a rounded tip. Its front edge is a convex arc and its back edge a concave arc.
- **Lens eye patch**: a cut-out, so it shows whatever ground the mark sits on.

## Versions
- **Primary, black and white**: ink #1B1916 on paper, or #F3ECE3 on ink. This is the logo.
- **Colour (outline)**: a line drawing. The body is a gain-blue outline #267CAA and the eye patch a loss-orange outline #D4561F, the pair the site uses for positive and negative returns. On dark grounds: #5BA3CE and #F48D60 (the site's dark-theme values). The line is 4 units on the 96 grid with round joins and scales with the mark. Use it at 32 px and up where the logo can be louder (slides, posters). Never fill it, swap the colours or add a third.

## Files
| File | Use |
|---|---|
| `orca-mark.svg` | Primary mark, `currentColor`, 96 box. Above 24 px |
| `orca-mark-16.svg` | Same mark with a larger eye patch. 24 px and below (site header, favicon) |
| `orca-mark-color.svg` / `orca-mark-color-dark.svg` | Outline colour mark for light / dark grounds |
| `orca-lockup.svg` / `orca-lockup-stacked.svg` | Mark + outlined Instrument Sans 600 "Orca" (−0.02em), `currentColor` |
| `orca-lockup-color.svg`, `orca-lockup-color-dark.svg`, `orca-lockup-stacked-color.svg`, `orca-lockup-stacked-color-dark.svg` | Outline colour lockups (the name stays solid `currentColor`) |
| `orca-icon.svg`, `icon-512.png`, `apple-touch-icon.png` | App icon: paper mark on an ink tile (the touch icon is full bleed; iOS rounds it) |
| `orca-icon-color.svg` | Outline colour mark on a paper tile |
| `favicon.svg`, `favicon-32.png` | Browser tab; the SVG is ink on light tabs and #F3ECE3 on dark tabs (`prefers-color-scheme`). Also in `web/public/` |
| `og-image.png` | 1200×630 link-preview card; copied to `web/public/`, and the build adds `og:image` from `SITE_URL` |
| `brand-sheet.png` | The guide: primary, colour, lockups, icons, rules |

## Rules
- **Clear space:** 1X on every side, where X is the eye-patch length (about a quarter of the mark's height).
- **Minimum size:** mark 16 px (use the `-16` file up to 24 px); outline colour mark 32 px; horizontal lockup 56 px wide; stacked lockup 40 px wide.
- **Don't:** stretch or rotate the mark, outline the black-and-white mark or fill the colour one, recolour beyond the two versions above, or re-set the name in live text.
- `favicon.svg` carries its own `<style>`; never paste it inline into an HTML page, where that style would apply to the whole page.
