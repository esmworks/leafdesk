/**
 * The AI eval's demo workspace: a small Turkish refrigeration and air-conditioning firm with
 * customers, quotes (amounts in TRY, EUR and USD), jobs, two quarterly balance sheets, a fixed
 * exchange-rate page and meeting notes. Every name, number and address is made up. The amounts are
 * picked so each arithmetic task in tasks.ts has one unambiguous answer; change them only together
 * with the expected values there.
 *
 * Imported by scripts/ai-eval.ts after DATABASE_URL is set (the database client reads it when it
 * is created). `seedEvalWorkspace` writes through the app's own functions (createPage, addProperty)
 * so pages get real bodies and rows real values.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, teamspace, user, workspace, workspaceAgent, workspaceMember } from "@/db/schema";
import { addProperty, getProperties } from "@/server/databases";
import { createPage } from "@/server/pages";

export const EUR_TRY = 36.8;
export const USD_TRY = 34.2;

export const CUSTOMERS = [
  {
    key: "ege",
    title: "Ege Gıda A.Ş.",
    city: "İzmir",
    contact: "Selin Aydın",
    phone: "0232 555 41 20",
    sector: "Gıda",
    email: "selin.aydin@egegida.example",
    notes: "Süt ürünleri ve peynir üreten fabrika. Soğuk hava depoları için yıllık bakım sözleşmemiz var. İletişim: selin.aydin@egegida.example",
  },
  {
    key: "akdeniz",
    title: "Akdeniz Otel Turizm",
    city: "Antalya",
    contact: "Kerem Polat",
    phone: "0242 715 08 64",
    sector: "Turizm",
    email: "kerem.polat@akdenizotel.example",
    notes: "Belek'te 320 odalı tatil oteli. Mutfak soğuk odaları ve klima santralleri bizde. E-posta: kerem.polat@akdenizotel.example",
  },
  {
    key: "karadeniz",
    title: "Karadeniz Lojistik Ltd.",
    city: "Samsun",
    contact: "Hakan Demir",
    phone: "0362 431 77 05",
    sector: "Lojistik",
    email: "hakan@karadenizlojistik.example",
    notes: "Soğuk zincir taşımacılığı yapıyor: 40 frigorifik araç ve bir aktarma deposu. Yazışmalar hakan@karadenizlojistik.example adresine.",
  },
  {
    key: "anadolu",
    title: "Anadolu Sağlık Grubu",
    city: "Ankara",
    contact: "Dr. Elif Kaya",
    phone: "0312 286 93 40",
    sector: "Sağlık",
    email: "elif.kaya@anadolusaglik.example",
    notes: "Özel hastane zinciri. İlaç ve aşı dolapları, ameliyathane iklimlendirmesi. Satın alma: elif.kaya@anadolusaglik.example",
  },
  {
    key: "marmara",
    title: "Marmara Market Zinciri",
    city: "İstanbul",
    contact: "Burak Şahin",
    phone: "0216 470 12 98",
    sector: "Perakende",
    email: "burak.sahin@marmaramarket.example",
    notes: "48 şubeli süpermarket zinciri; reyon dolapları ve şube soğuk odaları. Teknik müdür burak.sahin@marmaramarket.example",
  },
  {
    key: "toros",
    title: "Toros Yapı İnşaat",
    city: "Mersin",
    contact: "Ayşe Yıldız",
    phone: "0324 238 55 17",
    sector: "İnşaat",
    email: "ayse.yildiz@torosyapi.example",
    notes: "Konut siteleri yapan müteahhit firma; yeni projelerin merkezi klima tesisatı için görüşüyoruz. ayse.yildiz@torosyapi.example",
  },
] as const;

export type CustomerKey = (typeof CUSTOMERS)[number]["key"];

export const QUOTE_STATUSES = ["Taslak", "Gönderildi", "Kabul edildi", "Reddedildi"] as const;

export const QUOTES = [
  { key: "q1", no: "TKL-2026-008", title: "Soğuk oda yıllık bakım sözleşmesi", customer: "ege", amount: 148_000, currency: "TRY", status: "Kabul edildi", date: "2026-03-12", decided: "2026-03-20", days: 10, body: "Altı soğuk odanın üç ayda bir bakımı ve arıza müdahalesi. Teslim süresi: sözleşme imzasından sonra 10 gün içinde ilk bakım. Ödeme dört taksit." },
  { key: "q2", no: "TKL-2026-011", title: "Mutfak soğuk odası yenileme", customer: "akdeniz", amount: 412_500, currency: "TRY", status: "Gönderildi", date: "2026-04-02", decided: null, days: 21, body: "Ana mutfaktaki iki soğuk odanın panel, kapı ve evaporatör yenilemesi. Montaj ve devreye alma dahil. Teslim: sipariş onayından itibaren 21 gün." },
  { key: "q3", no: "TKL-2026-014", title: "Klima santrali kompresör değişimi", customer: "akdeniz", amount: 18_400, currency: "EUR", status: "Kabul edildi", date: "2026-05-20", decided: "2026-06-01", days: 42, body: "İki klima santralinde dört kompresörün değişimi. Kompresörler yurt dışından gelir; teslim süresi 6 hafta. Garanti 24 ay." },
  { key: "q4", no: "TKL-2026-017", title: "Aktarma deposu soğutma sistemi", customer: "karadeniz", amount: 1_265_000, currency: "TRY", status: "Gönderildi", date: "2026-06-08", decided: null, days: 45, body: "1.800 m² aktarma deposu için iki bağımsız soğutma devresi, alarm ve uzaktan izleme. Teslim süresi 45 gün." },
  { key: "q5", no: "TKL-2026-019", title: "Aşı dolabı (8 adet)", customer: "anadolu", amount: 9_750, currency: "EUR", status: "Gönderildi", date: "2026-07-01", decided: null, days: 5, body: "Sekiz adet +2/+8 °C aşı dolabı, sıcaklık kaydedici ile. Stoktan teslim: 5 gün içinde." },
  { key: "q6", no: "TKL-2026-022", title: "Reyon dolabı yenileme (12 şube)", customer: "marmara", amount: 2_340_000, currency: "TRY", status: "Kabul edildi", date: "2026-07-15", decided: "2026-08-04", days: 30, body: "On iki şubede reyon dolaplarının yenilenmesi. Şube başına montaj 2 gün; tüm teslim 30 gün içinde tamamlanır." },
  { key: "q7", no: "TKL-2026-024", title: "Merkezi klima tesisatı A blok", customer: "toros", amount: 86_200, currency: "USD", status: "Reddedildi", date: "2026-08-03", decided: "2026-08-25", days: 90, body: "A blok (64 daire) için VRF merkezi klima tesisatı. Teslim 90 gün." },
  { key: "q8", no: "TKL-2026-026", title: "Peynir olgunlaştırma odası", customer: "ege", amount: 676_000, currency: "TRY", status: "Gönderildi", date: "2026-09-04", decided: null, days: 28, body: "Nem kontrollü (%85-90) peynir olgunlaştırma odası, 120 m². Teslim süresi: 28 gün." },
  { key: "q9", no: "TKL-2026-028", title: "Kadıköy şubesi soğuk oda", customer: "marmara", amount: 254_300, currency: "TRY", status: "Taslak", date: "2026-10-06", decided: null, days: null, body: "Kadıköy şubesi için 24 m² soğuk oda. Keşif sonrası fiyat netleşecek." },
  { key: "q10", no: "TKL-2026-029", title: "Ameliyathane iklimlendirme bakımı", customer: "anadolu", amount: 96_000, currency: "TRY", status: "Kabul edildi", date: "2026-10-01", decided: "2026-10-09", days: null, body: "Üç ameliyathanenin hijyenik klima santrallerinin yıllık bakımı ve filtre değişimleri." },
] as const;

export type QuoteKey = (typeof QUOTES)[number]["key"];

export const JOB_STATUSES = ["Planlandı", "Devam ediyor", "Tamamlandı"] as const;
export const TECHNICIANS = ["Murat", "Zeynep", "Okan"] as const;

export const JOBS = [
  { key: "j1", title: "Ege Gıda soğuk oda periyodik bakım (Ekim)", customer: "ege", quote: "q1", status: "Devam ediyor", technician: "Murat", start: "2026-10-05" },
  { key: "j2", title: "Akdeniz Otel kompresör değişimi", customer: "akdeniz", quote: "q3", status: "Planlandı", technician: "Zeynep", start: "2026-10-27" },
  { key: "j3", title: "Marmara Market reyon dolabı montajı (1. etap)", customer: "marmara", quote: "q6", status: "Devam ediyor", technician: "Murat", start: "2026-09-01" },
  { key: "j4", title: "Anadolu Sağlık ameliyathane bakımı", customer: "anadolu", quote: "q10", status: "Planlandı", technician: "Okan", start: "2026-10-23" },
  { key: "j5", title: "Marmara Market reyon dolabı montajı (2. etap)", customer: "marmara", quote: "q6", status: "Planlandı", technician: "Murat", start: "2026-11-02" },
  { key: "j6", title: "Ege Gıda kompresör arıza müdahalesi", customer: "ege", quote: null, status: "Tamamlandı", technician: "Zeynep", start: "2026-08-14" },
] as const;

export type JobKey = (typeof JOBS)[number]["key"];

const RATES_PAGE = `Teklif, bütçe ve raporlarda Ekim 2026 için sabit kur kullanılır:

- 1 EUR = 36,80 TL
- 1 USD = 34,20 TL

Teklif tutarlarına KDV (%20) dahil değildir. İndirimler teklif tutarından düşülür.`;

const BALANCE_Q2 = `Dönem sonu: 30 Haziran 2026. Tutarlar TL.

| Kalem | Tutar |
| --- | --- |
| Nakit ve nakit benzerleri | 1.840.000 |
| Ticari alacaklar | 2.960.000 |
| Stoklar | 1.120.000 |
| **Dönen varlıklar toplamı** | **5.920.000** |
| Duran varlıklar | 3.480.000 |
| **Varlıklar toplamı** | **9.400.000** |
| Kısa vadeli yükümlülükler | 3.150.000 |
| Uzun vadeli yükümlülükler | 1.900.000 |
| Özkaynaklar | 4.350.000 |
| **Kaynaklar toplamı** | **9.400.000** |`;

const BALANCE_Q3 = `Dönem sonu: 30 Eylül 2026. Tutarlar TL.

| Kalem | Tutar |
| --- | --- |
| Nakit ve nakit benzerleri | 2.415.000 |
| Ticari alacaklar | 3.380.000 |
| Stoklar | 1.045.000 |
| **Dönen varlıklar toplamı** | **6.840.000** |
| Duran varlıklar | 3.410.000 |
| **Varlıklar toplamı** | **10.250.000** |
| Kısa vadeli yükümlülükler | 3.600.000 |
| Uzun vadeli yükümlülükler | 1.750.000 |
| Özkaynaklar | 4.900.000 |
| **Kaynaklar toplamı** | **10.250.000** |

Not: Ticari alacakların 1,2 milyon TL'si Marmara Market Zinciri'nden.`;

const MEETING_EGE = `**Katılanlar:** Selin Aydın (Ege Gıda), Murat (teknisyen), Deniz Yılmaz

## Konuşulanlar

- Peynir olgunlaştırma odası teklifi (TKL-2026-026) üzerinden geçildi. Teslim süresi 28 gün.
- Ege Gıda, odanın 15 Kasım 2026'dan önce çalışır durumda olmasını istiyor; yeni sezon peynirleri o tarihte gelecek.
- Nem kontrolü %85-90 aralığında olacak; Murat sensörlerin yedekli olmasını önerdi.
- Ödeme planı: %40 peşin, kalanı teslimde.

## Kararlar

- Teklifte revizyon gerekmiyor.
- Selin Hanım yönetim onayını 30 Eylül 2026'ya kadar iletecek.`;

const MEETING_AKDENIZ = `**Katılanlar:** Kerem Polat (Akdeniz Otel), Zeynep (teknisyen), Deniz Yılmaz

## Konuşulanlar

- Klima santrali kompresör değişimi otelin sezon kapanışından sonra, 27 Ekim 2026'da başlayacak. Kompresörler depoda.
- Mutfak soğuk odası yenileme teklifi (TKL-2026-011) için otel %5 indirim istedi.

## Kararlar

- İndirim talebi değerlendirilecek; otele 24 Ekim 2026'ya kadar cevap verilecek.`;

const MEETING_WEEKLY = `**Katılanlar:** Deniz Yılmaz, Murat, Zeynep, Okan

## Konuşulanlar

- Murat'ın iş yükü fazla: üç açık işi var.
- Marmara Market reyon dolabı montajının 2. etabının Okan'a devredilmesi önerildi. Okan'ın Kasım başında başka bir şantiyesi olabilir; kesin değil.
- Sabit kur politikası Kasım'da gözden geçirilecek.

## Kararlar

- 2. etabın kime verileceğine karar verilmedi; Okan'ın takvimi netleşince yeniden konuşulacak.`;

export type EvalSeed = {
  workspaceId: string;
  ownerId: string;
  ownerName: string;
  databases: { customers: string; quotes: string; jobs: string };
  customers: Record<CustomerKey, string>;
  quotes: Record<QuoteKey, string>;
  jobs: Record<JobKey, string>;
  pages: { rates: string; balanceQ2: string; balanceQ3: string; meetingEge: string; meetingAkdeniz: string; meetingWeekly: string; drafts: string };
  /** Property ids by database and name. */
  props: { customers: Record<string, string>; quotes: Record<string, string>; jobs: Record<string, string> };
  /** Option names by option id, for every select property of the three databases. */
  optionNames: Record<string, string>;
};

/** The ids an eval workspace uses, from its run id. */
export const evalIds = (run: string) => ({ workspaceId: `${run}-ws`, ownerId: `${run}-owner` });

/** Seeds a new demo workspace with its owner. `run` makes its ids (see evalIds). */
export async function seedEvalWorkspace(run: string, name: string): Promise<EvalSeed> {
  const { workspaceId, ownerId } = evalIds(run);
  const ownerName = "Deniz Yılmaz";
  await db.insert(user).values({ id: ownerId, name: ownerName, email: `${run}@ornek-sogutma.test` });
  await db.insert(workspace).values({ id: workspaceId, name });
  await db.insert(workspaceMember).values({ workspaceId, userId: ownerId, role: "owner" });
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const actor = { userId: ownerId };
  const top = (title: string, markdown: string) => createPage(actor, { workspaceId, teamspaceId: general.id, title, markdown });
  const under = (parentId: string, title: string, markdown: string) => createPage(actor, { workspaceId, parentId, title, markdown });

  // Databases first, so the relations between them can be made.
  const customersDb = await createPage(actor, { workspaceId, teamspaceId: general.id, kind: "database", title: "Müşteriler", seedProperties: false });
  const quotesDb = await createPage(actor, { workspaceId, teamspaceId: general.id, kind: "database", title: "Teklifler", seedProperties: false });
  const jobsDb = await createPage(actor, { workspaceId, teamspaceId: general.id, kind: "database", title: "İşler", seedProperties: false });

  await addProperty(ownerId, customersDb.id, { name: "Şehir", type: "select", options: [...new Set(CUSTOMERS.map((c) => c.city))] });
  await addProperty(ownerId, customersDb.id, { name: "Yetkili", type: "text" });
  await addProperty(ownerId, customersDb.id, { name: "Telefon", type: "text" });
  await addProperty(ownerId, customersDb.id, { name: "Notlar", type: "text" });

  await addProperty(ownerId, quotesDb.id, { name: "Teklif No", type: "text" });
  await addProperty(ownerId, quotesDb.id, { name: "Müşteri", type: "relation", relation: { databaseId: customersDb.id, twoWay: true, pairedName: "Teklifler" } });
  await addProperty(ownerId, quotesDb.id, { name: "Tutar", type: "number", number: { format: "number", decimals: 2 } });
  await addProperty(ownerId, quotesDb.id, { name: "Para birimi", type: "select", options: ["TRY", "EUR", "USD"] });
  await addProperty(ownerId, quotesDb.id, { name: "Durum", type: "select", options: [...QUOTE_STATUSES] });
  await addProperty(ownerId, quotesDb.id, { name: "Teklif tarihi", type: "date" });
  await addProperty(ownerId, quotesDb.id, { name: "Karar tarihi", type: "date" });

  await addProperty(ownerId, jobsDb.id, { name: "Müşteri", type: "relation", relation: { databaseId: customersDb.id, twoWay: true, pairedName: "İşler" } });
  await addProperty(ownerId, jobsDb.id, { name: "Teklif", type: "relation", relation: { databaseId: quotesDb.id, twoWay: true, pairedName: "İşler" } });
  await addProperty(ownerId, jobsDb.id, { name: "Durum", type: "select", options: [...JOB_STATUSES] });
  await addProperty(ownerId, jobsDb.id, { name: "Teknisyen", type: "select", options: [...TECHNICIANS] });
  await addProperty(ownerId, jobsDb.id, { name: "Başlangıç", type: "date" });
  await addProperty(ownerId, jobsDb.id, { name: "Bütçe (TL)", type: "number", number: { format: "currency", currency: "TRY", decimals: 2 } });

  const customers = {} as Record<CustomerKey, string>;
  for (const c of CUSTOMERS) {
    const row = await createPage(actor, {
      workspaceId,
      parentId: customersDb.id,
      title: c.title,
      properties: { Şehir: c.city, Yetkili: c.contact, Telefon: c.phone, Notlar: c.notes },
    });
    customers[c.key] = row.id;
  }
  const quotes = {} as Record<QuoteKey, string>;
  for (const q of QUOTES) {
    const row = await createPage(actor, {
      workspaceId,
      parentId: quotesDb.id,
      title: q.title,
      markdown: q.body,
      properties: {
        "Teklif No": q.no,
        Müşteri: [customers[q.customer]],
        Tutar: q.amount,
        "Para birimi": q.currency,
        Durum: q.status,
        "Teklif tarihi": q.date,
        ...(q.decided ? { "Karar tarihi": q.decided } : {}),
      },
    });
    quotes[q.key] = row.id;
  }
  const jobs = {} as Record<JobKey, string>;
  for (const j of JOBS) {
    const row = await createPage(actor, {
      workspaceId,
      parentId: jobsDb.id,
      title: j.title,
      properties: {
        Müşteri: [customers[j.customer]],
        ...(j.quote ? { Teklif: [quotes[j.quote]] } : {}),
        Durum: j.status,
        Teknisyen: j.technician,
        Başlangıç: j.start,
      },
    });
    jobs[j.key] = row.id;
  }

  const rates = await top("Kur ve fiyat politikası", RATES_PAGE);
  const balance = await top("Bilanço", "Çeyrek sonu bilançolar. Muhasebeden gelen rakamlar, denetlenmemiş.");
  const balanceQ2 = await under(balance.id, "Bilanço — 2026 2. çeyrek", BALANCE_Q2);
  const balanceQ3 = await under(balance.id, "Bilanço — 2026 3. çeyrek", BALANCE_Q3);
  const meetings = await top("Toplantı notları", "Müşteri ve iç toplantıların notları.");
  const meetingEge = await under(meetings.id, "2026-09-18 Ege Gıda toplantısı", MEETING_EGE);
  const meetingAkdeniz = await under(meetings.id, "2026-10-08 Akdeniz Otel toplantısı", MEETING_AKDENIZ);
  const meetingWeekly = await under(meetings.id, "2026-10-14 Haftalık iç toplantı", MEETING_WEEKLY);
  // The writing assistant's tasks work on this page's text (they send it as the selection).
  const drafts = await top("Taslaklar", "Müşterilere gidecek yazıların taslakları.");

  const propsOf = async (databaseId: string) => {
    const list = await getProperties(databaseId);
    return { byName: Object.fromEntries(list.map((p) => [p.name, p.id])), list };
  };
  const [c, q, j] = await Promise.all([propsOf(customersDb.id), propsOf(quotesDb.id), propsOf(jobsDb.id)]);
  const optionNames: Record<string, string> = {};
  for (const p of [...c.list, ...q.list, ...j.list]) for (const o of p.options.options ?? []) optionNames[o.id] = o.name;

  return {
    workspaceId,
    ownerId,
    ownerName,
    databases: { customers: customersDb.id, quotes: quotesDb.id, jobs: jobsDb.id },
    customers,
    quotes,
    jobs,
    pages: {
      rates: rates.id,
      balanceQ2: balanceQ2.id,
      balanceQ3: balanceQ3.id,
      meetingEge: meetingEge.id,
      meetingAkdeniz: meetingAkdeniz.id,
      meetingWeekly: meetingWeekly.id,
      drafts: drafts.id,
    },
    props: { customers: c.byName, quotes: q.byName, jobs: j.byName },
    optionNames,
  };
}

/** Deletes eval workspaces (by run id), their owners and their agents' users. */
export async function deleteEvalWorkspaces(runs: string[]) {
  if (!runs.length) return;
  const workspaceIds = runs.map((r) => evalIds(r).workspaceId);
  const bots = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.workspaceId, workspaceIds))).map((a) => a.userId);
  await db.delete(agentRun).where(inArray(agentRun.workspaceId, workspaceIds));
  await db.delete(workspace).where(inArray(workspace.id, workspaceIds));
  await db.delete(user).where(inArray(user.id, [...runs.map((r) => evalIds(r).ownerId), ...bots]));
}
