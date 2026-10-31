/** An id in the URL: a whole number, or null for anything else ("abc", "12abc", "1.5", "-3"). */
export function parseId(param: string | undefined): number | null {
  if (param === undefined || !/^\d+$/.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) ? id : null;
}
