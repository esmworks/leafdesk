import { describe, expect, it } from "vitest";
import { dashboardEmail, type DashboardEmail } from "./templates";

const email = (over: Partial<DashboardEmail> = {}): DashboardEmail => ({
  dashboardTitle: "Weekly <b>review</b>",
  periodName: "Last week (19–25 Oct 2026)",
  workspaceName: "Acme",
  widgets: [
    {
      kind: "number",
      title: "Revenue",
      url: null,
      value: "600",
      label: "Amount (Sum)",
      change: { amount: "140%", tone: "good", arrow: "up", versus: "12–18 Oct 2026" },
    },
    { kind: "number", title: "Jobs", url: null, value: "3", label: null, change: { amount: null, tone: "flat", arrow: null, versus: "12–18 Oct 2026" } },
    { kind: "table", title: "By status", url: null, head: ["Status", "Amount"], rows: [{ cells: ["<script>x</script>", "600"] }], more: "2 more rows" },
    { kind: "note", title: "Board", url: null, text: "Open the dashboard to see this view." },
  ],
  link: "https://leafdesk.test/w/ws/p/page",
  schedule: "Weekly, Mon · 08:00 (Europe/Istanbul)",
  setterName: "Ayşe",
  unsubscribeUrl: "https://leafdesk.test/dashboard-emails/unsubscribe?token=abc",
  ...over,
});

describe("dashboardEmail", () => {
  it("names the dashboard and the period in the subject", () => {
    expect(dashboardEmail("en", email()).subject).toBe("Weekly <b>review</b>: Last week (19–25 Oct 2026)");
  });

  it("shows figures with their change, tables and notes, escaped", () => {
    const { html, text } = dashboardEmail("en", email());
    expect(html).toContain("Weekly &lt;b&gt;review&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("color:#1e6b3a;\">▲ 140%</span> vs 12–18 Oct 2026");
    expect(html).toContain("Nothing to compare with in 12–18 Oct 2026");
    expect(html).toContain("2 more rows");
    expect(text).toContain("Revenue: 600");
    expect(text).toContain("▲ 140% vs 12–18 Oct 2026");
    expect(text).toContain("Open the dashboard to see this view.");
  });

  it("says who subscribed the reader and links to unsubscribe", () => {
    const { html, text } = dashboardEmail("en", email());
    expect(html).toContain("Ayşe subscribed you to this email");
    expect(html).toContain("https://leafdesk.test/dashboard-emails/unsubscribe?token=abc");
    expect(text).toContain("https://leafdesk.test/dashboard-emails/unsubscribe?token=abc");
    expect(dashboardEmail("en", email({ setterName: null })).html).toContain("You subscribed to this email");
  });
});
