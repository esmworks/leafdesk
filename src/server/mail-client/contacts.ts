import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { MailAddress } from "@/lib/mail-client";
import { requireOwnMailbox } from "./access";

/** Addresses a recipient field suggests at most. */
const SUGGESTED = 8;

/**
 * The addresses a recipient field suggests as one types: people the mailbox has had mail from
 * and, counting three times as much, written to, whose address or a word of whose name starts
 * with what is typed; the most written to first. Junk and the trash don't count.
 */
export async function suggestAddresses(userId: string, input: { mailboxId: string; query: string }): Promise<MailAddress[]> {
  const box = await requireOwnMailbox(userId, input?.mailboxId);
  const query = typeof input?.query === "string" ? input.query.trim().toLowerCase().slice(0, 100) : "";
  if (!query) return [];
  const start = `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const own = box.address.toLowerCase();
  const rows = await db.execute<{ address: string; name: string | null }>(sql`
    with counted as (
      select m.folder_id, lower(m.from_address) as address, m.from_name as name, m.sent_at as at, 1 as weight
      from mail_message m
      where m.mailbox_id = ${box.id}
      union all
      select m.folder_id, lower(a ->> 'address'), a ->> 'name', m.sent_at, 3
      from mail_message m
      cross join lateral jsonb_array_elements(m."to" || m.cc) as a
      where m.mailbox_id = ${box.id} and lower(m.from_address) = ${own}
    )
    select c.address, (array_agg(c.name order by c.at desc) filter (where coalesce(c.name, '') <> ''))[1] as name
    from counted c
    join mail_folder f on f.id = c.folder_id
    where coalesce(f.role, '') not in ('junk', 'trash')
      and c.address <> ${own} and c.address <> ''
      and (c.address like ${start} or lower(c.name) like ${start} or lower(c.name) like ${`% ${start}`})
    group by c.address
    order by sum(c.weight) desc, max(c.at) desc
    limit ${SUGGESTED}`);
  return rows.map((r) => ({ address: r.address, name: r.name ?? null }));
}
