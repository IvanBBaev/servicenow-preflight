/**
 * ServiceNow release families, oldest first (ADD-13 / F-C-19).
 *
 * The platform names each annual release after a city/region in alphabetical
 * order, so the position in this list is the release order. `glide.buildname`
 * carries the family name ("Xanadu", "Washingtondc"); {@link releaseFamily}
 * maps such a value onto an entry here. Keep this module dependency-free so
 * other checks (F-C-20 `deprecated-apis`) can import it.
 */
export const FAMILY_ORDER: readonly string[] = [
  "Aspen",
  "Berlin",
  "Calgary",
  "Dublin",
  "Eureka",
  "Fuji",
  "Geneva",
  "Helsinki",
  "Istanbul",
  "Jakarta",
  "Kingston",
  "London",
  "Madrid",
  "New York",
  "Orlando",
  "Paris",
  "Quebec",
  "Rome",
  "San Diego",
  "Tokyo",
  "Utah",
  "Vancouver",
  "Washington DC",
  "Xanadu",
  "Yokohama",
  "Zurich",
  "Australia",
  "Brazil",
];

/** Lowercase letters only: "Washington DC" and "Washingtondc" compare equal. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

const BY_KEY = new Map(FAMILY_ORDER.map((f) => [normalise(f), f]));
// The family is often written without its "DC" suffix.
BY_KEY.set("washington", "Washington DC");

/**
 * Map a release name (a `glide.buildname` value or a configured family) to its
 * canonical {@link FAMILY_ORDER} entry, or `undefined` when it is not a known
 * family. Matching ignores case, spaces and punctuation; when the whole value
 * does not match, its first word is tried ("Xanadu Patch 3" → "Xanadu").
 */
export function releaseFamily(name: string): string | undefined {
  const whole = BY_KEY.get(normalise(name));
  if (whole) return whole;
  const first = name.trim().split(/[\s_-]+/)[0] ?? "";
  return BY_KEY.get(normalise(first));
}

/**
 * Compare two canonical families by release order: negative when `a` is older
 * than `b`, zero when equal, positive when newer. Both must come from
 * {@link releaseFamily}.
 */
export function compareFamilies(a: string, b: string): number {
  return FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b);
}
