/**
 * Photos of the people behind the famous funds. The photo files live in src/assets/people/ (see the
 * README there): one `<slug>.jpg` per person, found by the text shown under the fund name.
 */
import credits from "../assets/people/credits.json";
import manifest from "../assets/people/people.json";

/** Every photo in the folder: file name without extension -> its built URL. Any of jpg, png, webp works. */
const FILES = Object.fromEntries(
  Object.entries(
    import.meta.glob("../assets/people/*.{jpg,jpeg,png,webp}", {
      eager: true,
      query: "?url",
      import: "default",
    }) as Record<string, string>,
  ).map(([path, url]) => [path.replace(/^.*\/|\.\w+$/g, ""), url]),
);

const MANIFEST = manifest as Record<string, string>;

/** "Warren Buffett" -> "warren-buffett": the photo's file name, lower case, words joined by hyphens. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The photo's slug for a fund's manager text: the manifest's choice, else the slug of the text itself. */
export function photoSlug(manager: string): string {
  return MANIFEST[manager] ?? slugify(manager);
}

/** The photo's URL for a fund's manager text, or undefined when the folder has none for it. */
export function photoOf(manager: string | null | undefined): string | undefined {
  return manager ? FILES[photoSlug(manager)] : undefined;
}

export type Credit = {
  name: string;
  author: string;
  licence: string;
  licence_url: string;
  source: string;
};

/** Credits of the photos the script fetched, for people whose photo is still in the folder. */
export function photoCredits(): (Credit & { slug: string })[] {
  return Object.entries(credits as Record<string, Credit>)
    .filter(([slug]) => slug in FILES)
    .map(([slug, c]) => ({ slug, ...c }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The credit line of one photo, for a tooltip; undefined for a photo added by hand. */
export function creditOf(manager: string | null | undefined): string | undefined {
  if (!manager) return undefined;
  const c = (credits as Record<string, Credit>)[photoSlug(manager)];
  return c ? `Photo: ${c.author}, ${c.licence}` : undefined;
}
