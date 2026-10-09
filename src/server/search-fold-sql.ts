/**
 * lib/search-fold in SQL, for comparing what the database holds with text folded in JS. Postgres
 * lowers "I" and "İ" to "i" (or to "i" and a combining dot, depending on the collation) but keeps
 * "ı"; this maps the last two to "i" as searchFold does.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const searchFoldSql = (value: SQLWrapper): SQL => sql`translate(lower(${value}), ${"ı̇"}, 'i')`;
