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
const PART_ENDS = new Set(["mahallesi", "caddesi", "sokak", "bulvarı", "sitesi", "bölgesi", "apartmanı", "plaza"]);

/** Words that mark a part as a detail of the address rather than the area it is in. */
const DETAIL_WORDS = new Set([...PART_ENDS, "yolu", "küme", "evler", "köyü", "çarşısı"]);

/** Words that end a direction rather than a place ("Cezaevi Karşısı"), which maps don't hold. */
const DIRECTIONS = new Set(["karşısı", "yanı", "arkası", "bitişiği", "önü", "girişi", "civarı"]);

/** Labels before a door, floor or flat number ("No: 13", "Kat 2", "D:4"). */
const NUMBER_LABELS = new Set(["no", "numara", "kat", "k", "d", "daire"]);

const STREETS = new Set(["Caddesi", "Sokak", "Bulvarı"]);

const COUNTRIES = new Set(["türkiye", "turkiye", "turkey", "tr"]);

const lower = (word: string) => word.toLocaleLowerCase("tr");

/** A door, flat or block number or letter: "13", "4/A", "88/a", "/1", "A". */
function isNumberish(word: string) {
  return /^\d*\/?\d*[a-zçğıöşü]?$/iu.test(word) && /[\dA-Za-zÇĞİÖŞÜçğıöşü]/u.test(word) && word.length <= 8 && (/\d/.test(word) || word.length === 1 || word.startsWith("/"));
}

const bareOf = (word: string) => lower(word.replace(/[.,]+$/, ""));

/** Whether a written word is "Sokak", "Cad." or another word for a street. */
const isStreet = (word: string | undefined) => !!word && STREETS.has(WORDS[bareOf(word)] ?? word.replace(/[.,]+$/, ""));

/** A piece of the address cleaned: abbreviations spelled out, numbers of doors, floors and blocks left out. */
function cleanWords(text: string): string[][] {
  const words = text.replace(/:/g, " ").split(/\s+/).filter(Boolean);
  const parts: string[][] = [[]];
  const current = () => parts[parts.length - 1];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    const dotted = raw.endsWith(".");
    const bare = bareOf(raw);
    if (!bare) continue;
    const next = words[i + 1];
    // "Kapı No: 5 A", "No:46/1", "D: 209": the label, its number and a letter or "/1" after it.
    if (bare === "kapı" && next && (NUMBER_LABELS.has(bareOf(next)) || isNumberish(bareOf(next)))) continue;
    if (NUMBER_LABELS.has(bare) && next && isNumberish(bareOf(next))) {
      i++;
      while (words[i + 1] && isNumberish(bareOf(words[i + 1])) && !isStreet(words[i + 2])) i++;
      continue;
    }
    if (bare === "blok" || bare === "blk") {
      // "19 Blok", "A Blok": the number or letter before goes too.
      if (current().length && isNumberish(current()[current().length - 1])) current().pop();
      continue;
    }
    const numbersStreet = isStreet(next);
    // A postcode, unless it numbers a street ("10003 Sk.").
    if (/^\d{5}$/.test(bare) && !numbersStreet) continue;
    // A door number with no label right after a street ("Ankara Cad. 359/K").
    const previous = parts[parts.length - 2];
    if (!current().length && previous && isStreet(previous[previous.length - 1]) && isNumberish(bare) && !numbersStreet) continue;
    const added = (WORDS[bare] ?? (dotted ? DOTTED[bare] : undefined) ?? raw.replace(/[.,]+$/, "")).split(" ");
    current().push(...added);
    if (PART_ENDS.has(lower(added[added.length - 1])) && i < words.length - 1) parts.push([]);
  }
  return parts.filter(
    (part) => part.length && !part.every((word) => isNumberish(word)) && !DIRECTIONS.has(lower(part[part.length - 1])),
  );
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
  if (name.length < 2 || name.length > 3 || name.some((word) => /\d/.test(word)) || (!neighbourhood && isDetail(words))) return null;
  return `${name[0]}${name.slice(1).map(lower).join("")}${neighbourhood ? " Mahallesi" : ""}`;
}

/**
 * One search to try: the text, the places (district, province) a result of it must lie in, and the
 * words of its street, neighbourhood or site a result must name (the service matches loosely, and
 * a numbered street may come back as another number's).
 */
export type AddressQuery = { query: string; within: string[]; names: string[] };

/**
 * Whether a found place is the place `query` names first itself ("Kozağaç Mahallesi", "Torbalı")
 * rather than something in it (a school, a hospital), which come back too.
 */
export function isNamedPlace(address: string, query: string): boolean {
  const [first] = address.split(",");
  const [asked] = query.split(",");
  return tokens(first).join(" ") === tokens(asked).join(" ");
}

/**
 * The searches to try for `query`, best first, at most `max`; the area alone always comes last.
 * The address as typed is searched as it is; the others are guesses, so each says the area a
 * result must lie in (a district name alone also matches villages elsewhere; see liesWithin).
 */
export function addressQueries(query: string, max = 6): AddressQuery[] {
  const typed = query.replace(/\s+/g, " ").trim();
  if (!typed) return [];
  // Notes in brackets go: "Çiğli (şube Menemen)".
  const plain = typed.replace(/\([^()]*\)/g, " ");
  // "Akhisar/Manisa" and "Akhisar – Hacı İshak Mah." are two pieces each, while "19/A" is a door number.
  const split = plain.split(/(,|\s[-–—]\s|\/(?=\s*\p{L}{2}))/u);
  // Only a piece of its own can name the area, or the district of "district/province" at a
  // piece's end; whatever else a street or a door number leaves behind in its piece ("İnşaat
  // Kapı No: 3 R") is a detail.
  const parts: { words: string[]; area: boolean }[] = [];
  for (let i = 0; i < split.length; i += 2) {
    const piece = cleanWords(split[i]);
    const beforeSlash = split[i + 1] === "/";
    piece.forEach((words, j) => {
      const last = parts[parts.length - 1];
      // "… Bornova/izmir, İzmir": a part repeated right away is one.
      if (last && fold(last.words.join(" ")) === fold(words.join(" "))) return;
      parts.push({ words, area: (piece.length === 1 || (beforeSlash && j === piece.length - 1)) && !isDetail(words) });
    });
  }

  // The area: a district and a province, written last ("…, Akhisar/Manisa") or first
  // ("Buca – Zafer Mah. …, İzmir"), with the country; it goes last in every search.
  let end = parts.length;
  const country = end > 0 && COUNTRIES.has(lower(parts[end - 1].words.join(" "))) ? parts[--end].words : null;
  let start = end;
  while (start > 0 && end - start < 2 && parts[start - 1].area) start--;
  let lead = 0;
  while (lead < start && lead < 2 - (end - start) && parts[lead].area) lead++;
  const seen = new Set<string>();
  const area = [...parts.slice(0, lead), ...parts.slice(start, end)]
    .map((part) => part.words)
    .filter((words) => {
      const key = fold(words.join(" "));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const within = area.map((words) => words.join(" "));
  if (country) area.push(country);
  // A detail repeating the area ("… No:88/a Bornova/İzmir") is the area.
  const details = parts
    .slice(lead, start)
    .map((part) => part.words)
    .filter((words) => !seen.has(fold(words.join(" "))));

  const queries: AddressQuery[] = [{ query: typed, within: [], names: [] }];
  const add = (list: string[][]) => {
    const text = [...list, ...area].map((words) => words.join(" ")).join(", ");
    const names = [...new Set(list.flat().flatMap(tokens).filter((word) => !UNIT_WORDS.has(word)))];
    if (text && !queries.some((q) => lower(q.query) === lower(text))) queries.push({ query: text, within, names });
  };
  add(details);
  if (!within.length || !details.length) return queries.slice(0, max);

  // The most specific detail first, as addresses here go from the neighbourhood to the door; a
  // bare name (a building's, a neighbourhood's without its word) after those with a street or
  // neighbourhood word.
  const marked = details.filter(isDetail).reverse();
  for (const detail of [...marked, ...details.filter((words) => !isDetail(words))]) {
    if (details.length > 1) add([detail]);
    const oneWord = joined(detail);
    if (oneWord) add([[oneWord]]);
  }
  const last = area.map((words) => words.join(" ")).join(", ");
  const before = queries.filter((q) => lower(q.query) !== lower(last));
  return [...before.slice(0, max - 1), { query: last, within, names: [] }];
}

/** Letters compared without case or Turkish marks ("Izmir" and "İzmir" alike). */
function fold(text: string) {
  return lower(text)
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Words of a name, folded, without punctuation: "İsmet İnönü-1 Cd." as ismet, inonu, 1, cd; a
 * number keeps its slash ("336/1" is not 1).
 */
function tokens(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}/]+/u)
    .map((word) => word.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

/** Words naming a kind of place rather than the place, which needn't match. */
const UNIT_WORDS = new Set(["mahallesi", "caddesi", "cadde", "sokak", "sokagi", "bulvari", "sitesi", "bolgesi", "apartmani", "plaza"]);

/**
 * Whether a place found for `query` is what it asked for: its address lies in the area the query
 * names (the last part, the province or the only one, and when there are more, one of the others:
 * "Menderes / Bornova" names two districts, of which the place is in one), and it names every word
 * of the query's street, neighbourhood or site.
 */
export function matches(address: string, { within, names }: Pick<AddressQuery, "within" | "names">): boolean {
  const found = fold(address);
  const words = new Set(tokens(address));
  const has = (part: string) => found.includes(fold(part));
  const [last, ...others] = [...within].reverse();
  if (last && !(has(last) && (!others.length || others.some(has)))) return false;
  return names.every((word) => words.has(word));
}
