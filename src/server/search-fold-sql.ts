/**
 * lib/search-fold in SQL, for comparing what the database holds with text folded in JS: the
 * search_fold function (migration 0093), which lowers text and maps "ı" and the combining dot left
 * after a lowered "İ" to "i". The search vectors hold words folded by it, so full-text queries fold
 * their text with it too.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const searchFoldSql = (value: SQLWrapper | string): SQL => sql`search_fold(${value})`;
