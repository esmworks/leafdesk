/**
 * Simpler spellings of a typed address for a geocoder that wants every word it is given to match
 * (Nominatim). Addresses as people write them carry abbreviations ("Mah.", "Cad."), door, block
 * and flat numbers, postcodes and "district/province", which the map data doesn't hold, so such a
 * search finds nothing. The spellings come best first: the address as typed, the address cleaned
 * up, then each detail of it with the area it is in, then the area alone.
 */

/** Abbreviations written with or without a dot. */
const WORDS: Record<string, string> = {
  mah: "Mahallesi",
  mh: "Mahallesi",
  mahalle: "Mahallesi",
  mahallesi: "Mahallesi",
  cad: "Caddesi",
  cd: "Caddesi",
  cadde: "Caddesi",
  sok: "Sokak",
  sk: "Sokak",
  sokağı: "Sokak",
  blv: "Bulvarı",
  bulv: "Bulvarı",
  bul: "Bulvarı",
  osb: "Organize Sanayi Bölgesi",
};

/** Abbreviations only with a dot, since without one they are ordinary words. */
const DOTTED: Record<string, string> = {
  san: "Sanayi",
  sit: "Sitesi",
  ser: "Serbest",
  böl: "Bölgesi",
  apt: "Apartmanı",
};

/** Words after which a new part of the address starts ("X Mahallesi Y Caddesi"). */
const PART_ENDS = new Set(["mahallesi", "caddesi", "sokak", "bulvarı", "sitesi", "bölgesi"]);

/** Words that mark a part as a detail of the address rather than the area it is in. */
const DETAIL_WORDS = new Set([...PART_ENDS, "apartmanı", "yolu", "küme", "evler", "köyü", "plaza", "çarşısı"]);

/** Labels before a door, floor or flat number ("No: 13", "Kat 2", "D:4"). */
const NUMBER_LABELS = new Set(["no", "numara", "kat", "k", "d", "daire"]);

const STREETS = new Set(["Caddesi", "Sokak", "Bulvarı"]);

const COUNTRIES = new Set(["türkiye", "turkiye", "turkey", "tr"]);

const lower = (word: string) => word.toLocaleLowerCase("tr");

function isNumberish(word: string) {
  return /^\d+[a-zçğıöşü]?$/iu.test(word) || /^\d+\/\d*[a-zçğıöşü]?$/iu.test(word) || /^[a-zçğıöşü]$/iu.test(word);
}

/** One part of the address cleaned: abbreviations spelled out, numbers of doors, floors and blocks left out. */
function cleanWords(text: string): string[][] {
  const words = text.replace(/:/g, " ").split(/\s+/).filter(Boolean);
  const parts: string[][] = [[]];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    const dotted = raw.endsWith(".");
    const bare = lower(raw.replace(/\.+$/, ""));
    if (!bare) continue;
    const next = words[i + 1];
    if (NUMBER_LABELS.has(bare) && next && isNumberish(next.replace(/[.,]+$/, ""))) {
      i++;
      continue;
    }
    if (bare === "blok" || bare === "blk") {
      // "19 Blok", "A Blok": the number or letter before goes too.
      const current = parts[parts.length - 1];
      if (current.length && isNumberish(current[current.length - 1])) current.pop();
      continue;
    }
    // A postcode, unless it numbers a street ("10003 Sk.").
    if (/^\d{5}$/.test(bare) && !(next && STREETS.has(WORDS[lower(next.replace(/\.+$/, ""))] ?? ""))) continue;
    const added = (WORDS[bare] ?? (dotted ? DOTTED[bare] : undefined) ?? raw.replace(/\.+$/, "")).split(" ");
    parts[parts.length - 1].push(...added);
    if (PART_ENDS.has(lower(added[added.length - 1])) && i < words.length - 1) parts.push([]);
  }
  return parts.filter((part) => part.length);
}

function isDetail(words: string[]) {
  return words.some((word) => DETAIL_WORDS.has(lower(word)) || /\d/.test(word));
}

/**
 * A neighbourhood of a few words as the map data often spells it, in one word ("Hacı İshak
 * Mahallesi" as "Hacıishak Mahallesi"); null for other parts.
 */
function joined(words: string[]): string | null {
  const neighbourhood = lower(words[words.length - 1]) === "mahallesi";
  const name = neighbourhood ? words.slice(0, -1) : words;
  if (name.length < 2 || name.length > 3 || (!neighbourhood && isDetail(words))) return null;
  return `${name[0]}${name.slice(1).map(lower).join("")}${neighbourhood ? " Mahallesi" : ""}`;
}

/** One search to try: the text, and the places (district, province) a result of it must name. */
export type AddressQuery = { query: string; within: string[] };

/**
 * The searches to try for `query`, best first, at most `max`; the area alone always comes last.
 * The address as typed is searched as it is; the others are guesses, so each says which parts of
 * the area a result must lie in (a district name alone also matches villages elsewhere).
 */
export function addressQueries(query: string, max = 6): AddressQuery[] {
  const typed = query.replace(/\s+/g, " ").trim();
  if (!typed) return [];
  // "Akhisar/Manisa" and "Akhisar – Hacı İshak Mah." are two parts each, while "19/A" is a door number.
  const pieces = typed.split(/,|\s[-–—]\s|\/(?=\s*\p{L}{2})/u);
  let parts = pieces.flatMap(cleanWords);

  // The area: the last parts that are no detail, at most a district and a province (and the
  // country); written first instead ("Akhisar – Hacı İshak Mah."), it is moved to the end.
  let end = parts.length;
  const country = end > 0 && COUNTRIES.has(lower(parts[end - 1].join(" "))) ? parts[--end] : null;
  let start = end;
  while (start > 0 && end - start < 2 && !isDetail(parts[start - 1])) start--;
  if (start === end) {
    let lead = 0;
    while (lead < end && lead < 2 && !isDetail(parts[lead])) lead++;
    if (lead < end) {
      parts = [...parts.slice(lead, end), ...parts.slice(0, lead), ...parts.slice(end)];
      start = end - lead;
    }
  }
  const within = parts.slice(start, end).map((words) => words.join(" "));
  const area = [...parts.slice(start, end), ...(country ? [country] : [])];
  const details = parts.slice(0, start);

  const queries: AddressQuery[] = [{ query: typed, within: [] }];
  const add = (list: string[][]) => {
    const text = list.map((words) => words.join(" ")).join(", ");
    if (text && !queries.some((q) => lower(q.query) === lower(text))) queries.push({ query: text, within });
  };
  add(parts);
  if (!area.length || !details.length) return queries.slice(0, max);

  // The most specific detail first: addresses here go from the neighbourhood to the door.
  for (const detail of [...details].reverse()) {
    if (details.length > 1) add([detail, ...area]);
    const oneWord = joined(detail);
    if (oneWord) add([[oneWord], ...area]);
  }
  const last = area.map((words) => words.join(" ")).join(", ");
  const before = queries.filter((q) => lower(q.query) !== lower(last));
  return [...before.slice(0, max - 1), { query: last, within }];
}

/** Letters compared without case or Turkish marks ("Izmir" and "İzmir" alike). */
function fold(text: string) {
  return lower(text)
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Whether a found place's address names every part of `within`. */
export function liesWithin(address: string, within: string[]): boolean {
  const found = fold(address);
  return within.every((part) => found.includes(fold(part)));
}
