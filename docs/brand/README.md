# Orca logo ("Lune")

Last verified: 2026-11-14

The official logo (v1.1, approved by the owner 2026-11-14). On the website: the header is the outlined lockup (`web/src/components/Logo.tsx`, from `orca-lockup-16.svg`), the Not found page and the footer show the mark, and the favicon files and the link-preview card (`og-image.png`, shipped as `og-default.png`) are in `web/public/`. `brand-sheet.png` is the full guide as an image.

## Idea
An orca breaking the surface, built from three shapes, every curve a circular arc:
- **Crescent body**: circle C1 minus a larger circle C2. The two horns are the tail and the jaw; the hollow arc reads as the white belly.
- **Short fin**: wide and swept back, with a rounded tip. Its front edge is a convex arc and its back edge a concave arc.
- **Lens eye patch**: a cut-out, so it shows whatever ground the mark sits on.

## Versions
- **Primary, black and white**: ink #1B1916 on paper, or #F3ECE3 on ink. This is the logo.
- **Colour, orange eye**: the solid mark with the eye patch filled in dark orange #A84118 (darker than the site's loss orange #D4561F: a killer whale's eye). The body stays `currentColor`, so one file works on paper (ink body) and on ink (paper body). Use it at 24 px and up, where the logo can be louder (slides, posters, the colour icon). No other colours, and never orange anywhere but the eye.

## Files
| File | Use |
|---|---|
| `orca-mark.svg` | Primary mark, `currentColor`, 96 box. Above 24 px |
| `orca-mark-16.svg` | Same mark with a larger eye patch. 24 px and below (site header, favicon) |
| `orca-mark-color.svg` | Colour mark: `currentColor` body, #A84118 eye |
| `orca-lockup.svg` / `orca-lockup-stacked.svg` | Mark + outlined Instrument Sans 600 "Orca" (−0.02em), `currentColor` |
| `orca-lockup-16.svg` | Horizontal lockup with the `-16` eye patch, for lockups under about 30 px tall (the site header, 18 px) |
| `orca-lockup-color.svg`, `orca-lockup-stacked-color.svg` | Colour lockups: `currentColor` body and name, #A84118 eye |
| `orca-icon.svg`, `icon-512.png`, `apple-touch-icon.png` | App icon: paper mark on an ink tile (the touch icon is full bleed; iOS rounds it) |
| `orca-icon-color.svg` | Colour icon: ink orca with the orange eye on a paper tile |
| `favicon.svg`, `favicon-32.png` | Browser tab; the SVG is ink on light tabs and #F3ECE3 on dark tabs (`prefers-color-scheme`). Also in `web/public/` |
| `og-image.png` | 1200×630 link-preview card; shipped as `web/public/og-default.png`, which the build links as `og:image` when `SITE_URL` is set |
| `brand-sheet.png` | The guide: primary, colour, lockups, icons, rules |

## Rules
- **Clear space:** 1X on every side, where X is the eye-patch length (about a quarter of the mark's height).
- **Minimum size:** mark 16 px (use the `-16` file up to 24 px); colour mark 24 px; horizontal lockup 56 px wide; stacked lockup 40 px wide.
- **Don't:** stretch or rotate the mark, outline the mark, colour anything but the eye, use another orange, or re-set the name in live text.
- Use the outlined lockup wherever the name appears as the brand, rather than typing "Orca" next to the mark.
- `favicon.svg` carries its own `<style>`; never paste it inline into an HTML page, where that style would apply to the whole page.
