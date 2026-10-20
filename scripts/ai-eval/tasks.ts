/**
 * The AI eval's tasks, in Turkish, over the demo workspace of seed.ts. Each goes through the code
 * path a person sets off in the app: the AI chat (startChat), AI autofill properties
 * (requestAutofill), the editor's writing assistant (startEditorAction) and an agent's run asked
 * for by an owner (requestAgentRun). scripts/ai-eval.ts runs them in this order: the tasks that
 * write come last, so the reading ones see the seeded data.
 *
 * Grading is deterministic where the answer is a fact (a number, a name, a row's values, a
 * refusal); only the writing assistant's text quality goes to a judge model, with the rubric
 * written here. Every task also has scripted answers for the fake model: "right" ones that should
 * score full marks and "wrong" ones that should not, to show the graders can fail.
 */
import type { FakeChatRequest, FakeReply } from "@/server/ai/fake-openai";
import { type Check, fold, hasWord, mentions, saysNotFound, statesNumber } from "./grade";
import { CUSTOMERS, EUR_TRY, QUOTES, type EvalSeed } from "./seed";

export type Variant = "right" | "wrong";

/** A row as the graders see it: values by property name, options by name, relations as titles. */
export type RowView = { id: string; title: string; values: Record<string, unknown> };

export type TaskContext = {
  seed: EvalSeed;
  row(rowId: string): Promise<RowView>;
  rows(databaseId: string): Promise<RowView[]>;
  /** Titles of the demo databases' rows whose title or values changed since the task started (new rows included). */
  changed(): Promise<string[]>;
};

export type ChatOutput = { text: string; steps: string[]; error: string | null; approvals: number };
export type AgentOutput = { status: string; code: string | null; answer: string; steps: number };

type FakeChat = (seed: EvalSeed, variant: Variant) => (request: FakeChatRequest) => FakeReply;

type Base = { id: string; title: string };

export type ChatTask = Base & {
  kind: "chat";
  question: string;
  /** The page the chat is opened on (the page's own AI chat), when not the whole workspace. */
  scope?: (seed: EvalSeed) => string;
  /** "ask" (the app's default) declines every change it is asked to approve; "auto" lets it write. */
  mode?: "ask" | "auto";
  grade(output: ChatOutput, ctx: TaskContext): Check[] | Promise<Check[]>;
  fake: FakeChat;
};

export type AutofillTask = Base & {
  kind: "autofill";
  database: "customers" | "quotes";
  property: string;
  prompt: string;
  includeBody?: boolean;
  cases(seed: EvalSeed): { rowId: string; label: string; expected: string }[];
  /** How a value is compared with the expected one. */
  compare: "word" | "integer" | "email";
  fake: (variant: Variant) => (prompt: string) => string;
};

export type WritingTask = Base & {
  kind: "writing";
  action: "shorten" | "fix" | "custom" | "summarize";
  /** The selection (all but summarize, which reads `page`). */
  text?: string;
  instruction?: string;
  page?: (seed: EvalSeed) => string;
  grade(text: string): Check[];
  judge: { task: string; rubric: string };
  fake: (variant: Variant) => string;
};

export type AgentTask = Base & {
  kind: "agent";
  row: (seed: EvalSeed) => string;
  task: string;
  grade(output: AgentOutput, ctx: TaskContext): Promise<Check[]>;
  fake: FakeChat;
};

export type EvalTask = ChatTask | AutofillTask | WritingTask | AgentTask;

// ----------------------------------------------------------------------------------- helpers

const check = (name: string, pass: boolean, detail?: unknown, weight?: number): Check => ({
  name,
  pass,
  ...(weight !== undefined ? { weight } : {}),
  ...(detail !== undefined ? { detail: typeof detail === "string" ? detail : JSON.stringify(detail) } : {}),
});

const digits = (text: string) => text.replace(/\D/g, "");

/** A model that makes these tool calls, one turn each, then answers. */
function scripted(calls: { name: string; arguments: Record<string, unknown> }[], answer: string) {
  return (request: FakeChatRequest): FakeReply => {
    const made = request.messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    if (made < calls.length) return { toolCalls: [calls[made]] };
    return { text: answer };
  };
}

const read = (pageId: string) => ({ name: "read_page", arguments: { page_id: pageId } });
const query = (databaseId: string, filters: Record<string, unknown>[] = []) => ({ name: "query_database", arguments: { database_id: databaseId, filters } });
const fx = (q: (typeof QUOTES)[number]) => q.amount * (q.currency === "EUR" ? EUR_TRY : q.currency === "USD" ? 34.2 : 1);
const quote = (key: string) => QUOTES.find((q) => q.key === key)!;

/** That no row but `title`'s changed during the task. */
async function untouched(ctx: TaskContext, title: string): Promise<Check> {
  const others = (await ctx.changed()).filter((t) => t !== title);
  return check("başka satıra dokunulmadı", others.length === 0, others);
}

/** Whether two values are the same (relations and multi-selects as lists of names). */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ------------------------------------------------------------------------------ the texts

const SHORTEN_TEXT = [
    "Bugün Akdeniz Otel'den Kerem Polat ile uzun bir telefon görüşmesi yaptık ve kompresör değişimiyle ilgili bütün ayrıntıların üzerinden tek tek geçtik.",
    "Otelin yaz sezonu Ekim ayının sonunda kapanacağı için işe sezon kapanışından hemen sonra, 27 Ekim'de başlamaya karar verdik; daha erken başlamak misafirleri rahatsız edeceği için mümkün görünmüyor.",
    "Kompresörler yurt dışından sipariş edildiği için gelmeleri 6 hafta sürdü ama şu anda hepsi depomuzda bekliyor, yani malzeme tarafında bir gecikme beklemiyoruz.",
    "Kerem Bey garanti süresini de sordu; kompresörlerin 24 ay garantili olduğunu kendisine tekrar hatırlattık.",
    "Görüşmenin sonunda Kerem Bey, mutfak soğuk odası teklifimiz için %5 indirim istediklerini bir kez daha söyledi; bu talebi kendi aramızda değerlendirip en geç 24 Ekim'e kadar otele cevap vereceğimizi ilettik.",
].join(" ");

const FIX_TEXT =
  "Merhaba Selin Hanım, toplantıda konuştuğumuz herşeyi özetliyorum. Bir çok kalemde anlaştık, yanlız teslim tarihini netleştirmemiz lazım. Malesef kompresörlerin gelişi gecikebilir; bu durumda size hemen haber vericez. Herkez onay verirse siparişi Pazartesi günü geçeceğiz. Şirketinizde birşey değişirse lütfen bize de bildirin.";

const FIX_ERRORS: [string, string][] = [
  ["herşeyi", "her şeyi"],
  ["bir çok", "birçok"],
  ["yanlız", "yalnız"],
  ["malesef", "maalesef"],
  ["vericez", "vereceğiz"],
  ["herkez", "herkes"],
  ["birşey", "bir şey"],
];

const FIX_FIXED =
  "Merhaba Selin Hanım, toplantıda konuştuğumuz her şeyi özetliyorum. Birçok kalemde anlaştık, yalnız teslim tarihini netleştirmemiz lazım. Maalesef kompresörlerin gelişi gecikebilir; bu durumda size hemen haber vereceğiz. Herkes onay verirse siparişi Pazartesi günü geçeceğiz. Şirketinizde bir şey değişirse lütfen bize de bildirin.";

const FORMAL_TEXT =
  "Selam Kerem abi, kompresörler depoya geldi sayılır ya, 27'sinde işe başlıyoruz. Bi de mutfak teklifindeki indirim işine bakıcaz, en geç 24'ünde dönerim. Kolay gelsin!";

// --------------------------------------------------------------------------------- the tasks

export const TASKS: EvalTask[] = [
  // ── Chat: looking things up ─────────────────────────────────────────────────────────────────
  {
    kind: "chat",
    id: "chat.page-lookup",
    title: "Sayfa sohbeti: müşteri sayfasından yetkili ve telefon",
    question: "Bu müşterinin yetkilisi kim ve telefon numarası ne?",
    scope: (s) => s.customers.anadolu,
    grade: (o) => [check("yetkili: Elif Kaya", mentions(o.text, "Elif Kaya"), o.text), check("telefon: 0312 286 93 40", digits(o.text).includes("3122869340"), o.text)],
    fake: (s, v) => scripted([read(s.customers.anadolu)], v === "right" ? "Yetkili Dr. Elif Kaya, telefon 0312 286 93 40." : "Yetkili Dr. Elif Kaya, telefon 0312 286 93 04."),
  },
  {
    kind: "chat",
    id: "chat.quote-lookup",
    title: "Tek teklif: numara ve tutar",
    question: "Akdeniz Otel'e verilen kompresör değişimi teklifinin numarası ve tutarı nedir?",
    grade: (o) => [
      check("TKL-2026-014", mentions(o.text, "TKL-2026-014"), o.text),
      check("18.400", statesNumber(o.text, 18_400), o.text),
      check("para birimi EUR", /eur|€|avro|euro/i.test(o.text), o.text),
    ],
    fake: (s, v) => scripted([query(s.databases.quotes, [{ property: "Teklif No", op: "contains", value: "TKL" }])], v === "right" ? "Teklif TKL-2026-014, tutarı 18.400 EUR." : "Teklif TKL-2026-011, tutarı 412.500 TL."),
  },
  {
    kind: "chat",
    id: "chat.meeting-synthesis",
    title: "Birden çok sayfa: toplantı kararı + teklif durumu",
    question: "Ege Gıda ile yapılan son toplantıda ne kararlaştırıldı? Orada konuşulan teklifin tutarı ve şu anki durumu ne?",
    grade: (o) => [
      check("onay tarihi 30 Eylül", /30\s*eyl[uü]l|30\.0?9\.2026|2026-09-30/i.test(o.text), o.text),
      check("tutar 676.000", statesNumber(o.text, 676_000), o.text),
      check("durum: Gönderildi", fold(o.text).includes("gonderil"), o.text),
      check("revizyon gerekmediği", fold(o.text).includes("revizyon") || fold(o.text).includes("revize"), o.text, 0.5),
    ],
    fake: (s, v) =>
      scripted(
        [read(s.pages.meetingEge), read(s.quotes.q8)],
        v === "right"
          ? "Toplantıda teklifte revizyon gerekmediğine ve Selin Hanım'ın yönetim onayını 30 Eylül 2026'ya kadar ileteceğine karar verildi. Konuşulan teklif TKL-2026-026: 676.000 TL, durumu Gönderildi."
          : "Toplantıda teklifin revize edilmesine karar verildi. Teklif 676.000 TL ve kabul edildi.",
      ),
  },
  {
    kind: "chat",
    id: "chat.jobs-synthesis",
    title: "Veritabanları arası: teknisyenin açık işleri ve müşterileri",
    question: "Murat'ın üzerindeki tamamlanmamış işler hangileri ve hangi müşterilere ait?",
    grade: (o) => {
      const t = fold(o.text);
      const extra = ["kompresor degisimi", "ameliyathane", "ariza mudahalesi"].filter((x) => t.includes(x));
      return [
        check("periyodik bakım işi", t.includes("periyodik bakim"), o.text),
        check("1. etap", /1\.?\s*etap|birinci etap/.test(t), o.text),
        check("2. etap", /2\.?\s*etap|ikinci etap/.test(t), o.text),
        check("müşteriler: Ege Gıda ve Marmara Market", t.includes("ege gida") && t.includes("marmara"), o.text),
        check("başka teknisyenin işi yok", extra.length === 0, extra),
      ];
    },
    fake: (s, v) =>
      scripted(
        [query(s.databases.jobs, [{ property: "Teknisyen", op: "equals", value: "Murat" }])],
        v === "right"
          ? "Murat'ın üç açık işi var:\n- Ege Gıda soğuk oda periyodik bakım (Ekim) — Ege Gıda A.Ş.\n- Marmara Market reyon dolabı montajı (1. etap) — Marmara Market Zinciri\n- Marmara Market reyon dolabı montajı (2. etap) — Marmara Market Zinciri"
          : "Murat'ın işleri: Ege Gıda soğuk oda periyodik bakım ve Ege Gıda kompresör arıza müdahalesi (Ege Gıda).",
      ),
  },

  // ── Chat: arithmetic over amounts ───────────────────────────────────────────────────────────
  {
    kind: "chat",
    id: "chat.accepted-sum",
    title: "Toplama: kabul edilen TRY teklifleri",
    question: "Kabul edilmiş TL (TRY) tekliflerinin toplam tutarı ne kadar?",
    grade: (o) => [check("2.584.000", statesNumber(o.text, 2_584_000), o.text)],
    fake: (s, v) =>
      scripted([query(s.databases.quotes, [{ property: "Durum", op: "equals", value: "Kabul edildi" }])], v === "right" ? "Kabul edilmiş TRY teklifleri: 148.000 + 2.340.000 + 96.000 = **2.584.000 TL**." : "Toplam 2.488.000 TL."),
  },
  {
    kind: "chat",
    id: "chat.pending-fx",
    title: "Kurla toplama: bekleyen teklifler TL karşılığı",
    question: "Gönderilmiş ama henüz karar verilmemiş tekliflerin toplamı TL olarak ne kadar? Döviz tekliflerini Kur ve fiyat politikası sayfasındaki kurla çevir.",
    grade: (o) => [check("2.712.300", statesNumber(o.text, 2_712_300), o.text)],
    fake: (s, v) =>
      scripted(
        [query(s.databases.quotes, [{ property: "Durum", op: "equals", value: "Gönderildi" }]), read(s.pages.rates)],
        v === "right" ? "412.500 + 1.265.000 + 676.000 + 9.750 × 36,80 (358.800) = **2.712.300 TL**." : "412.500 + 1.265.000 + 676.000 + 9.750 = 2.363.250 TL.",
      ),
  },
  {
    kind: "chat",
    id: "chat.customer-fx",
    title: "Kurla toplama: bir müşterinin tüm teklifleri",
    question: "Akdeniz Otel'e verilen tüm tekliflerin TL karşılığı toplam ne kadar? Sabit kuru kullan.",
    grade: (o) => [check("1.089.620", statesNumber(o.text, fx(quote("q2")) + fx(quote("q3"))), o.text)],
    fake: (s, v) =>
      scripted([read(s.customers.akdeniz), read(s.pages.rates)], v === "right" ? "412.500 TL + 18.400 EUR × 36,80 = 412.500 + 677.120 = 1.089.620 TL." : "412.500 + 18.400 = 430.900 TL."),
  },
  {
    kind: "chat",
    id: "chat.discount",
    title: "Toplantı + yüzde: istenen indirimle yeni tutar",
    question: "Akdeniz Otel'in indirim istediği teklif hangisi ve istenen indirim uygulanırsa yeni tutar ne olur?",
    grade: (o) => [check("TKL-2026-011", mentions(o.text, "TKL-2026-011") || mentions(o.text, "mutfak soğuk oda"), o.text), check("391.875", statesNumber(o.text, 391_875), o.text)],
    fake: (s, v) =>
      scripted([read(s.pages.meetingAkdeniz), read(s.quotes.q2)], v === "right" ? "TKL-2026-011 (mutfak soğuk odası yenileme): 412.500 TL × 0,95 = 391.875 TL." : "TKL-2026-011: 412.500 TL'den %5 indirimle 391.000 TL."),
  },
  {
    kind: "chat",
    id: "chat.ratios",
    title: "Bilanço oranları: cari oran ve asit-test",
    question: "2026 3. çeyrek bilançosuna göre cari oran ve asit-test oranı kaç? İki ondalık basamakla ver.",
    grade: (o) => [check("cari oran 1,90", statesNumber(o.text, 1.9, { absolute: 0.006 }), o.text), check("asit-test 1,61", statesNumber(o.text, 1.61, { absolute: 0.006 }), o.text)],
    fake: (s, v) =>
      scripted([read(s.pages.balanceQ3)], v === "right" ? "Cari oran 6.840.000 / 3.600.000 = 1,90; asit-test (6.840.000 − 1.045.000) / 3.600.000 = 1,61." : "Cari oran 2,17; asit-test 1,90."),
  },
  {
    kind: "chat",
    id: "chat.cash-change",
    title: "İki sayfa farkı: nakitteki değişim, TL ve yüzde",
    question: "Nakit ve nakit benzerleri 2026'nın 2. çeyreğinden 3. çeyreğine kaç TL ve yüzde kaç değişti?",
    grade: (o) => [check("575.000 TL", statesNumber(o.text, 575_000), o.text), check("%31,25", statesNumber(o.text, 31.25, { absolute: 0.06 }), o.text)],
    fake: (s, v) =>
      scripted([read(s.pages.balanceQ2), read(s.pages.balanceQ3)], v === "right" ? "1.840.000 TL'den 2.415.000 TL'ye: 575.000 TL artış, %31,25." : "575.000 TL artış, %23,8."),
  },

  // ── Chat: the answer isn't in the workspace ─────────────────────────────────────────────────
  {
    kind: "chat",
    id: "chat.absent-tax",
    title: "Cevap yok: kayıtta olmayan vergi numarası",
    question: "Karadeniz Lojistik'in vergi numarası nedir?",
    grade: (o) => [check("bulunmadığını söylüyor", saysNotFound(o.text), o.text, 2), check("numara uydurmuyor", !/(^|\D)\d{10,11}(\D|$)/.test(o.text.replace(/ /g, "")) || saysNotFound(o.text), o.text)],
    fake: (s, v) => scripted([read(s.customers.karadeniz)], v === "right" ? "Karadeniz Lojistik'in vergi numarası çalışma alanında kayıtlı değil." : "Vergi numarası 4810329576."),
  },
  {
    kind: "chat",
    id: "chat.absent-customer",
    title: "Cevap yok: olmayan müşteri",
    question: "Mavi Marin'e verdiğimiz teklifin tutarı ne kadardı?",
    grade: (o) => [check("bulunmadığını söylüyor", saysNotFound(o.text), o.text, 2), check("ona bir teklif numarası yakıştırmıyor", !/TKL-\d{4}-\d{3}/.test(o.text) || saysNotFound(o.text), o.text, 0.5)],
    fake: (s, v) => scripted([{ name: "search_pages", arguments: { query: "Mavi Marin" } }], v === "right" ? "Çalışma alanında Mavi Marin adında bir müşteri ya da teklif bulamadım." : "Mavi Marin teklifi TKL-2026-030, 310.000 TL."),
  },
  {
    kind: "chat",
    id: "chat.absent-year",
    title: "Cevap yok: yanlış öncüllü soru (2025'te kabul edilen teklif)",
    question: "Toros Yapı'nın 2025 yılında kabul ettiği teklif hangisiydi ve tutarı neydi?",
    grade: (o) => {
      const t = fold(o.text);
      const none = saysNotFound(o.text) || /\b(hic|herhangi)\b/.test(t);
      const claims = statesNumber(o.text, 86_200) && !t.includes("reddedil");
      return [check("2025'te kabul edilmiş teklif olmadığını söylüyor", none, o.text, 2), check("reddedilen teklifi kabul edilmiş gibi sunmuyor", !claims, o.text)];
    },
    fake: (s, v) =>
      scripted(
        [read(s.customers.toros)],
        v === "right" ? "Toros Yapı'nın 2025'te kabul ettiği bir teklif yok. Tek teklifi TKL-2026-024 (86.200 USD), 2026'da reddedildi." : "2025'te TKL-2026-024 kabul edildi, tutarı 86.200 USD.",
      ),
  },

  // ── AI autofill properties ──────────────────────────────────────────────────────────────────
  {
    kind: "autofill",
    id: "autofill.sector",
    title: "AI özelliği: sektör sınıflandırma (6 müşteri)",
    database: "customers",
    property: "Sektör",
    prompt: "Müşterinin sektörünü şu notlara göre belirle: {Notlar}\nYalnızca şu seçeneklerden birini yaz: Gıda, Turizm, Lojistik, Sağlık, Perakende, İnşaat. Başka hiçbir şey yazma.",
    cases: (s) => CUSTOMERS.map((c) => ({ rowId: s.customers[c.key], label: c.title, expected: c.sector })),
    compare: "word",
    fake: (v) => (prompt) => {
      const c = CUSTOMERS.find((x) => prompt.includes(`Title: ${x.title}`));
      if (!c) return "?";
      return v === "right" ? c.sector : c.key === "marmara" ? "Gıda" : c.key === "akdeniz" ? "Konaklama" : c.sector;
    },
  },
  {
    kind: "autofill",
    id: "autofill.delivery-days",
    title: "AI özelliği: teklif metninden teslim süresi (gün)",
    database: "quotes",
    property: "Teslim (gün)",
    prompt: "Teklif metnindeki teslim süresini gün olarak yaz: yalnızca bir tam sayı (hafta verilmişse güne çevir). Metinde teslim süresi yoksa yalnızca - yaz.",
    includeBody: true,
    cases: (s) => QUOTES.map((q) => ({ rowId: s.quotes[q.key], label: q.no, expected: q.days === null ? "-" : String(q.days) })),
    compare: "integer",
    fake: (v) => (prompt) => {
      const q = QUOTES.find((x) => prompt.includes(`Title: ${x.title}`));
      if (!q) return "?";
      if (v === "wrong" && q.key === "q3") return "6";
      if (v === "wrong" && q.key === "q9") return "0";
      return q.days === null ? "-" : String(q.days);
    },
  },
  {
    kind: "autofill",
    id: "autofill.email",
    title: "AI özelliği: notlardan e-posta çıkarma",
    database: "customers",
    property: "E-posta",
    prompt: "{Notlar}\n\nBu metindeki e-posta adresini yaz. Yalnızca adresi yaz; adres yoksa - yaz.",
    cases: (s) => CUSTOMERS.map((c) => ({ rowId: s.customers[c.key], label: c.title, expected: c.email })),
    compare: "email",
    fake: (v) => (prompt) => {
      const c = CUSTOMERS.find((x) => prompt.includes(`Title: ${x.title}`));
      if (!c) return "?";
      return v === "right" ? c.email : `E-posta: ${c.email.replace(".example", ".com")}`;
    },
  },

  // ── The writing assistant ───────────────────────────────────────────────────────────────────
  {
    kind: "writing",
    id: "writing.shorten",
    title: "Yazma asistanı: kısalt",
    action: "shorten",
    text: SHORTEN_TEXT,
    grade: (t) => {
      const ratio = t.length / SHORTEN_TEXT.length;
      return [
        check("en fazla %65 uzunlukta", ratio <= 0.65, `oran ${ratio.toFixed(2)}`),
        check("Kerem Polat korunmuş", mentions(t, "Kerem Polat"), t),
        check("27 Ekim korunmuş", /27\s*ekim/i.test(t), t),
        check("6 hafta korunmuş", /6\s*hafta|altı hafta|42 gün/i.test(t), t, 0.5),
      ];
    },
    judge: {
      task: "Make the text shorter and more concise, about half as long, keeping what matters and its language (Turkish).",
      rubric: [
        "- The output is clearly shorter than the input (roughly half).",
        "- Every decision, date, person and amount in the input survives: Kerem Polat, 27 October start after the season, compressors in stock but delivered in 6 weeks from abroad, 24-month warranty, the 5% discount request and the 24 October answer deadline.",
        "- Nothing is added that the input doesn't say.",
        "- Correct, natural Turkish in the same register as the input.",
      ].join("\n"),
    },
    fake: (v) =>
      v === "right"
        ? "Kerem Polat ile görüştük: kompresör değişimi sezon kapanışından sonra 27 Ekim'de başlayacak; kompresörler 6 haftada geldi ve depoda, garanti 24 ay. Otel mutfak soğuk odası teklifinde %5 indirim istedi; 24 Ekim'e kadar cevap vereceğiz."
        : SHORTEN_TEXT,
  },
  {
    kind: "writing",
    id: "writing.fix",
    title: "Yazma asistanı: yazım ve dil bilgisi düzelt",
    action: "fix",
    text: FIX_TEXT,
    grade: (t) =>
      FIX_ERRORS.map(([wrong, right]) =>
        check(`${wrong} → ${right}`, !hasWord(t, wrong) && fold(t).includes(fold(right)), t),
      ),
    judge: {
      task: "Fix the spelling and grammar mistakes in this Turkish text, changing nothing else.",
      rubric: [
        `- These mistakes are fixed: ${FIX_ERRORS.map(([w, r]) => `"${w}" → "${r}"`).join(", ")}.`,
        "- Nothing else changes: same sentences, same meaning, same tone; no rewording beyond the fixes.",
        "- No new mistakes are introduced.",
      ].join("\n"),
    },
    fake: (v) => (v === "right" ? FIX_FIXED : FIX_TEXT.replace("herşeyi", "her şeyi")),
  },
  {
    kind: "writing",
    id: "writing.formal",
    title: "Yazma asistanı: resmî dile çevir (özel komut)",
    action: "custom",
    instruction: "Bu mesajı müşteriye gönderilecek resmî ve kibar bir e-postaya çevir. Bilgileri değiştirme, yeni bilgi ekleme.",
    text: FORMAL_TEXT,
    grade: (t) => {
      const informal = ["abi", "selam", "bi", "bakıcaz", "dönerim", "kolay gelsin"].filter((w) => hasWord(t, w));
      if (/(^|\s)ya[,!]/i.test(t)) informal.push("ya,");
      return [
        check("gündelik ifade kalmamış", informal.length === 0, informal),
        check("27'si korunmuş", /\b27\b/.test(t), t),
        check("24'ü korunmuş", /\b24\b/.test(t), t),
        check("Kerem Bey'e hitap", /kerem\s+bey/i.test(t), t, 0.5),
      ];
    },
    judge: {
      task: "Rewrite this message as a formal, polite email to the customer (Turkish), without changing or adding information.",
      rubric: [
        "- Formal, polite business Turkish (e.g. addressing \"Kerem Bey\", siz form); no slang or casual words.",
        "- Keeps every fact: compressors (almost) arrived at the depot, work starts on the 27th, the kitchen quote discount will be looked at, an answer by the 24th at the latest.",
        "- Adds no facts, promises, prices or dates that the input doesn't have.",
        "- Reads as a ready-to-send email (greeting, body, closing).",
      ].join("\n"),
    },
    fake: (v) =>
      v === "right"
        ? "Sayın Kerem Bey,\n\nKompresörler depomuza ulaşmak üzeredir; çalışmaya ayın 27'sinde başlayacağız. Mutfak soğuk odası teklifimizdeki indirim talebinizi değerlendirip en geç ayın 24'ünde size dönüş yapacağız.\n\nSaygılarımızla,"
        : FORMAL_TEXT.replace("Selam", "Merhaba"),
  },
  {
    kind: "writing",
    id: "writing.summarize",
    title: "Yazma asistanı: toplantı notunu özetle",
    action: "summarize",
    page: (s) => s.pages.meetingEge,
    grade: (t) => {
      const sentences = t.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
      return [
        check("en fazla dört cümle", sentences <= 4, `${sentences} cümle`),
        check("15 Kasım", /15\s*kas[ıi]m/i.test(t), t),
        check("30 Eylül", /30\s*eyl[uü]l/i.test(t), t),
        check("hangi teklif", mentions(t, "TKL-2026-026") || mentions(t, "olgunlaştırma"), t, 0.5),
      ];
    },
    judge: {
      task: "Summarize this page in one short paragraph of at most four sentences, in the page's language (Turkish). Plain prose: no heading, no list.",
      rubric: [
        "- One paragraph, at most four sentences, no heading or list.",
        "- Covers what matters: the cheese ripening room quote (TKL-2026-026, 28 days), the customer wants it working before 15 November 2026, no revision needed, Selin Aydın sends management approval by 30 September 2026. Humidity 85-90% and the 40% advance payment are welcome but optional.",
        "- Nothing invented; correct Turkish.",
      ].join("\n"),
    },
    fake: (v) =>
      v === "right"
        ? "Ege Gıda ile peynir olgunlaştırma odası teklifi (TKL-2026-026, 28 gün teslim) görüşüldü; müşteri odanın 15 Kasım 2026'dan önce çalışmasını istiyor. Teklifte revizyon gerekmiyor ve Selin Aydın yönetim onayını 30 Eylül 2026'ya kadar iletecek."
        : "## Özet\n- Ege Gıda toplantısı yapıldı.\n- Teklif konuşuldu.\n- Ödeme planı belirlendi.\n- Nem kontrolü konuşuldu.\n- Sensörler yedekli olacak.",
  },

  // ── Agents (a run an owner asks for, on a row) ──────────────────────────────────────────────
  {
    kind: "agent",
    id: "agent.accept-discount",
    title: "Ajan: indirimle onaylanan teklifi güncelle",
    row: (s) => s.quotes.q2,
    task: "Müşteri bu teklifi istediği %5 indirimle onayladı. Tutarı indirimli tutarla güncelle, durumu Kabul edildi yap ve karar tarihini 2026-10-20 olarak yaz.",
    grade: async (o, ctx) => {
      const r = await ctx.row(ctx.seed.quotes.q2);
      return [
        check("çalışma bitti", o.status === "done", o),
        check("Tutar 391.875", Math.abs(Number(r.values.Tutar) - 391_875) < 0.01, r.values.Tutar),
        check("Durum Kabul edildi", r.values.Durum === "Kabul edildi", r.values.Durum),
        check("Karar tarihi 2026-10-20", String(r.values["Karar tarihi"] ?? "").startsWith("2026-10-20"), r.values["Karar tarihi"]),
        check("Para birimi hâlâ TRY", r.values["Para birimi"] === "TRY", r.values["Para birimi"]),
        await untouched(ctx, r.title),
      ];
    },
    fake: (s, v) =>
      scripted(
        [
          read(s.pages.meetingAkdeniz),
          { name: "update_row", arguments: { row_id: s.quotes.q2, properties: { Tutar: v === "right" ? 391_875 : 412_500, Durum: "Kabul edildi", "Karar tarihi": "2026-10-20" } } },
        ],
        "Teklifi %5 indirimle 391.875 TL'ye güncelledim, durumu Kabul edildi yaptım.",
      ),
  },
  {
    kind: "agent",
    id: "agent.budget-fx",
    title: "Ajan: bağlı teklifin tutarını kurla çevirip bütçeye yaz",
    row: (s) => s.jobs.j2,
    task: "Bu işin bağlı olduğu teklifin tutarını Kur ve fiyat politikası sayfasındaki sabit kurla TL'ye çevir ve işin Bütçe (TL) alanına yaz.",
    grade: async (o, ctx) => {
      const r = await ctx.row(ctx.seed.jobs.j2);
      return [
        check("çalışma bitti", o.status === "done", o),
        check("Bütçe 677.120", Math.abs(Number(r.values["Bütçe (TL)"]) - fx(quote("q3"))) < 0.01, r.values["Bütçe (TL)"]),
        check("Teknisyen değişmedi", r.values.Teknisyen === "Zeynep", r.values.Teknisyen),
        await untouched(ctx, r.title),
      ];
    },
    fake: (s, v) =>
      scripted(
        [read(s.quotes.q3), read(s.pages.rates), { name: "update_row", arguments: { row_id: s.jobs.j2, properties: { "Bütçe (TL)": v === "right" ? 677_120 : 18_400 } } }],
        "Teklif 18.400 EUR; 36,80 kurla 677.120 TL bütçe yazdım.",
      ),
  },
  {
    kind: "agent",
    id: "agent.no-decision",
    title: "Ajan: karar verilmemişse hiçbir şeyi değiştirme",
    row: (s) => s.jobs.j5,
    task: "Haftalık iç toplantı notuna göre bu işin teknisyeni değişti mi? Toplantıda kesin bir karar verildiyse Teknisyen alanını güncelle; verilmediyse hiçbir şeyi değiştirme ve nedenini kısaca yaz.",
    grade: async (o, ctx) => {
      const r = await ctx.row(ctx.seed.jobs.j5);
      return [
        check("çalışma bitti", o.status === "done", o),
        check("Teknisyen hâlâ Murat", r.values.Teknisyen === "Murat", r.values.Teknisyen, 2),
        check("Durum değişmedi", r.values.Durum === "Planlandı", r.values.Durum),
        await untouched(ctx, r.title),
        check("cevap kararın verilmediğini söylüyor", /karar/i.test(o.answer), o.answer, 0.5),
      ];
    },
    fake: (s, v) =>
      scripted(
        v === "right" ? [read(s.pages.meetingWeekly)] : [read(s.pages.meetingWeekly), { name: "update_row", arguments: { row_id: s.jobs.j5, properties: { Teknisyen: "Okan" } } }],
        v === "right" ? "Değişiklik yapmadım: toplantıda 2. etabın kime verileceğine karar verilmedi." : "Teknisyeni Okan yaptım.",
      ),
  },

  // ── Chat that writes (mode auto) ────────────────────────────────────────────────────────────
  {
    kind: "chat",
    id: "chat.create-row",
    title: "Sohbetle kayıt: yeni teklif satırı ekle",
    mode: "auto",
    question:
      "Teklifler veritabanına yeni bir teklif ekle: başlığı “Merkezi klima tesisatı B blok”, Teklif No TKL-2026-031, müşteri Toros Yapı İnşaat, tutar 79.500 USD, durum Taslak, teklif tarihi 20 Ekim 2026.",
    grade: async (o, ctx) => {
      const rows = await ctx.rows(ctx.seed.databases.quotes);
      const made = rows.filter((r) => r.values["Teklif No"] === "TKL-2026-031" || mentions(r.title, "B blok"));
      const r = made[0];
      const v = r?.values ?? {};
      return [
        check("satır eklendi (bir kez)", made.length === 1, made.map((m) => m.title)),
        check("başlık", Boolean(r && mentions(r.title, "Merkezi klima tesisatı B blok")), r?.title),
        check("Teklif No", v["Teklif No"] === "TKL-2026-031", v["Teklif No"]),
        check("Müşteri: Toros Yapı İnşaat", same(v.Müşteri, ["Toros Yapı İnşaat"]), v.Müşteri),
        check("Tutar 79.500", Number(v.Tutar) === 79_500, v.Tutar),
        check("Para birimi USD", v["Para birimi"] === "USD", v["Para birimi"]),
        check("Durum Taslak", v.Durum === "Taslak", v.Durum),
        check("Teklif tarihi 2026-10-20", String(v["Teklif tarihi"] ?? "").startsWith("2026-10-20"), v["Teklif tarihi"]),
      ];
    },
    fake: (s, v) =>
      scripted(
        [
          {
            name: "create_row",
            arguments: {
              database_id: s.databases.quotes,
              title: "Merkezi klima tesisatı B blok",
              properties: {
                "Teklif No": "TKL-2026-031",
                Müşteri: ["Toros Yapı İnşaat"],
                Tutar: v === "right" ? 79_500 : 79.5,
                "Para birimi": v === "right" ? "USD" : "TRY",
                Durum: "Taslak",
                "Teklif tarihi": "2026-10-20",
              },
            },
          },
        ],
        "Teklifi ekledim.",
      ),
  },
  {
    kind: "chat",
    id: "chat.update-row",
    title: "Sohbetle kayıt: iş durumunu ve tarihini güncelle",
    mode: "auto",
    question: "Akdeniz Otel kompresör değişimi işinin durumunu “Devam ediyor” yap ve başlangıç tarihini 28 Ekim 2026 olarak güncelle.",
    grade: async (_o, ctx) => {
      const r = await ctx.row(ctx.seed.jobs.j2);
      const others = (await ctx.changed()).filter((t) => t !== r.title);
      return [
        check("Durum Devam ediyor", r.values.Durum === "Devam ediyor", r.values.Durum),
        check("Başlangıç 2026-10-28", String(r.values.Başlangıç ?? "").startsWith("2026-10-28"), r.values.Başlangıç),
        check("Teknisyen değişmedi", r.values.Teknisyen === "Zeynep", r.values.Teknisyen),
        check("başka satıra dokunulmadı", others.length === 0, others),
      ];
    },
    fake: (s, v) =>
      scripted(
        [
          query(s.databases.jobs, [{ property: "title", op: "contains", value: "kompresör" }]),
          { name: "update_row", arguments: { row_id: v === "right" ? s.jobs.j2 : s.jobs.j6, properties: { Durum: "Devam ediyor", Başlangıç: "2026-10-28" } } },
        ],
        "İşi güncelledim.",
      ),
  },
];
