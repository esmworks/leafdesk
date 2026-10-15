/**
 * Ready-made connections an owner picks from when adding one (see lib/connections.ts): services
 * whose remote MCP server Leafdesk can sign in to as it is. Each was checked against the service:
 * an OAuth one answers with metadata naming this address and lets Leafdesk register itself (or
 * takes its client metadata document); an open one answers without any sign-in; a token one takes
 * the service's key as a bearer token. A service that signs in only apps registered with it
 * beforehand is marked `client`: the owner registers one there and enters its client ID and secret,
 * unless the instance has one for it (CONNECTION_OAUTH_CLIENTS).
 */
import type { ConnectionAuthType, EventPreset } from "./connections";

export const CATALOG_CATEGORIES = [
  "projects",
  "docs",
  "design",
  "dev",
  "monitoring",
  "analytics",
  "sales",
  "messaging",
  "support",
  "marketing",
  "finance",
  "meetings",
  "hr",
  "automation",
  "web",
  "media",
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export type CatalogEntry = {
  /** Stable key, from the name. */
  id: string;
  name: string;
  /** The MCP endpoint, as a URL's href (how connections are saved). */
  url: string;
  authType: ConnectionAuthType;
  category: CatalogCategory;
  /** How the service signs its events, when it isn't Leafdesk's own scheme. */
  eventPreset?: EventPreset;
  /** Where to make the token, for token entries. */
  tokenHelp?: string;
  /**
   * For an OAuth service that signs in only apps registered with it: where an owner registers one
   * (with Leafdesk's redirect URL), and whether the app may have no secret.
   */
  client?: { help: string; secretOptional?: boolean };
};

type Row = [name: string, url: string, authType: ConnectionAuthType, extra?: Pick<CatalogEntry, "eventPreset" | "tokenHelp" | "client">];

const ROWS: Record<CatalogCategory, Row[]> = {
  projects: [
    ["Asana", "https://mcp.asana.com/v2/mcp", "oauth", { client: { help: "https://app.asana.com/0/my-apps" } }],
    ["Atlassian (Jira, Confluence)", "https://mcp.atlassian.com/v2/mcp", "oauth"],
    ["Basecamp", "https://mcp.basecamp.com/mcp", "oauth"],
    ["ClickUp", "https://mcp.clickup.com/mcp", "oauth"],
    ["Linear", "https://mcp.linear.app/mcp", "oauth"],
    ["monday.com", "https://mcp.monday.com/mcp", "oauth"],
    ["Productboard", "https://mcp.productboard.com/mcp", "oauth"],
    ["Reclaim", "https://mcp.reclaim.ai/mcp", "oauth"],
    ["Shortcut", "https://mcp.shortcut.com/mcp", "oauth"],
    ["Todoist", "https://ai.todoist.net/mcp", "oauth"],
  ],
  docs: [
    ["Airtable", "https://mcp.airtable.com/mcp", "oauth"],
    ["AWS Knowledge", "https://knowledge-mcp.global.api.aws/", "none"],
    ["Coda", "https://coda.io/apis/mcp", "oauth"],
    ["Box", "https://mcp.box.com/", "oauth", { client: { help: "https://app.box.com/developers/console" } }],
    ["Context7", "https://mcp.context7.com/mcp", "none"],
    ["DeepWiki", "https://mcp.deepwiki.com/mcp", "none"],
    ["Dropbox", "https://mcp.dropbox.com/mcp", "oauth"],
    ["Egnyte", "https://mcp-server.egnyte.com/mcp", "oauth"],
    ["Evernote", "https://mcp.evernote.com/mcp", "oauth"],
    ["GitBook", "https://mcp.gitbook.com/mcp", "oauth"],
    ["Guru", "https://mcp.api.getguru.com/mcp", "oauth"],
    ["Microsoft Learn", "https://learn.microsoft.com/api/mcp", "none"],
    ["Mintlify", "https://mcp.mintlify.com/mcp", "oauth"],
    ["Notion", "https://mcp.notion.com/mcp", "oauth"],
    ["Raindrop.io", "https://api.raindrop.io/rest/v2/ai/mcp", "oauth"],
    ["Readwise", "https://mcp2.readwise.io/mcp", "oauth"],
  ],
  design: [
    ["Canva", "https://mcp.canva.com/mcp", "oauth"],
    ["Contentful", "https://mcp.contentful.com/mcp", "oauth"],
    ["Excalidraw", "https://mcp.excalidraw.com/mcp", "none"],
    ["Framer", "https://mcp.framer.com/mcp", "oauth"],
    ["Gamma", "https://mcp.gamma.app/mcp", "oauth"],
    ["Lucid", "https://mcp.lucid.app/mcp", "oauth"],
    ["Miro", "https://mcp.miro.com/", "oauth"],
    ["Mural", "https://mcp-canvas.mural.co/mcp", "oauth"],
    ["Sanity", "https://mcp.sanity.io/", "oauth"],
    ["Webflow", "https://mcp.webflow.com/mcp", "oauth"],
    ["Whimsical", "https://mcp.whimsical.com/mcp", "oauth"],
    ["Wix", "https://mcp.wix.com/mcp", "oauth"],
    ["WordPress.com", "https://public-api.wordpress.com/wpcom/v2/mcp/v1", "oauth"],
  ],
  dev: [
    ["Algolia", "https://mcp.algolia.com/mcp", "oauth"],
    ["Buildkite", "https://mcp.buildkite.com/mcp", "oauth"],
    ["CircleCI", "https://mcp.circleci.com/v1/mcp", "oauth"],
    ["Clerk", "https://mcp.clerk.com/mcp", "oauth"],
    ["Cloudflare", "https://mcp.cloudflare.com/mcp", "oauth"],
    ["Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp", "none"],
    ["DevCycle", "https://mcp.devcycle.com/mcp", "oauth"],
    ["DigitalOcean", "https://mcp.digitalocean.com/mcp", "oauth"],
    [
      "GitHub",
      "https://api.githubcopilot.com/mcp/",
      "token",
      { eventPreset: "github", tokenHelp: "https://github.com/settings/personal-access-tokens/new" },
    ],
    ["GitLab", "https://gitlab.com/api/v4/mcp", "oauth"],
    ["Heroku", "https://mcp.heroku.com/mcp", "oauth"],
    ["InstantDB", "https://mcp.instantdb.com/mcp", "oauth"],
    ["Jam", "https://mcp.jam.dev/mcp", "oauth"],
    ["Neon", "https://mcp.neon.tech/mcp", "oauth"],
    ["Netlify", "https://mcp.netlify.com/mcp", "oauth"],
    ["Postman", "https://mcp.postman.com/mcp", "oauth"],
    ["Prisma Postgres", "https://mcp.prisma.io/mcp", "oauth"],
    ["Railway", "https://mcp.railway.com/", "oauth"],
    ["Render", "https://mcp.render.com/mcp", "token", { tokenHelp: "https://dashboard.render.com/u/settings?add-api-key" }],
    ["Retool", "https://mcp.retool.com/mcp", "oauth"],
    ["Semgrep", "https://mcp.semgrep.ai/mcp", "oauth"],
    ["Statsig", "https://api.statsig.com/v1/mcp", "oauth"],
    ["Supabase", "https://mcp.supabase.com/mcp", "oauth"],
    ["Upstash", "https://mcp.upstash.com/mcp", "oauth"],
    ["Vercel", "https://mcp.vercel.com/", "oauth"],
    ["WorkOS", "https://mcp.workos.com/mcp", "oauth"],
  ],
  monitoring: [
    ["Axiom", "https://mcp.axiom.co/mcp", "oauth"],
    ["Cloudflare Observability", "https://observability.mcp.cloudflare.com/mcp", "oauth"],
    ["Cloudflare Radar", "https://radar.mcp.cloudflare.com/mcp", "oauth"],
    ["Datadog", "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", "oauth"],
    ["Grafana", "https://mcp.grafana.com/mcp", "oauth"],
    ["Honeycomb", "https://mcp.honeycomb.io/mcp", "oauth"],
    ["incident.io", "https://mcp.incident.io/mcp", "oauth"],
    ["New Relic", "https://mcp.newrelic.com/mcp/", "oauth"],
    ["PagerDuty", "https://mcp.pagerduty.com/mcp", "oauth", { client: { help: "https://docs.pagerduty.com/developer/private-apps" } }],
    ["Rootly", "https://mcp.rootly.com/mcp", "oauth"],
    ["Sentry", "https://mcp.sentry.dev/mcp", "oauth"],
    ["Vanta", "https://mcp.vanta.com/mcp", "oauth"],
  ],
  analytics: [
    ["Amplitude", "https://mcp.amplitude.com/mcp", "oauth"],
    ["Hex", "https://app.hex.tech/mcp", "oauth"],
    ["Mixpanel", "https://mcp.mixpanel.com/mcp", "oauth"],
    ["Pendo", "https://app.pendo.io/mcp/v0/shttp", "oauth"],
    ["PostHog", "https://mcp.posthog.com/mcp", "oauth"],
    ["ThoughtSpot", "https://agent.thoughtspot.app/mcp", "oauth"],
  ],
  sales: [
    ["Apollo.io", "https://mcp.apollo.io/mcp", "oauth"],
    ["Attio", "https://mcp.attio.com/mcp", "oauth"],
    ["Close", "https://mcp.close.com/mcp", "oauth"],
    ["Gong", "https://mcp.gong.io/mcp", "oauth"],
    [
      "HubSpot",
      "https://mcp.hubspot.com/",
      "oauth",
      { client: { help: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server" } },
    ],
    ["Hunter", "https://mcp.hunter.io/mcp", "oauth"],
    ["Instantly", "https://mcp.instantly.ai/mcp", "oauth"],
    ["PandaDoc", "https://mcp.pandadoc.com/v1/mcp", "oauth"],
    ["ZoomInfo", "https://mcp.zoominfo.com/mcp", "oauth"],
  ],
  messaging: [
    ["Discord", "https://mcp.discord.com/mcp", "oauth", { client: { help: "https://discord.com/developers/applications", secretOptional: true } }],
    ["Slack", "https://mcp.slack.com/mcp", "oauth", { eventPreset: "slack", client: { help: "https://api.slack.com/apps" } }],
  ],
  support: [
    ["Front", "https://mcp.frontapp.com/mcp", "oauth", { client: { help: "https://dev.frontapp.com/docs/create-and-manage-apps" } }],
    ["Help Scout", "https://mcp.helpscout.net/mcp", "oauth"],
    ["Intercom", "https://mcp.intercom.com/mcp", "oauth"],
  ],
  marketing: [
    ["beehiiv", "https://mcp.beehiiv.com/mcp", "oauth"],
    ["Buffer", "https://mcp.buffer.com/mcp", "oauth"],
    ["Customer.io", "https://mcp.customer.io/mcp", "oauth"],
    ["Jotform", "https://mcp.jotform.com/", "oauth"],
    ["Klaviyo", "https://mcp.klaviyo.com/mcp", "oauth"],
    ["Resend", "https://mcp.resend.com/mcp", "oauth"],
    ["Semrush", "https://mcp.semrush.com/v1/mcp", "oauth"],
    ["Similarweb", "https://mcp.similarweb.com/mcp", "token"],
    ["Tally", "https://api.tally.so/mcp", "oauth"],
    ["Typeform", "https://api.typeform.com/mcp", "oauth"],
  ],
  finance: [
    ["Airwallex", "https://mcp.airwallex.com/mcp", "oauth"],
    ["Daloopa", "https://mcp.daloopa.com/server/mcp", "oauth"],
    ["FactSet", "https://mcp.factset.com/mcp", "oauth"],
    ["Mercury", "https://mcp.mercury.com/mcp", "oauth"],
    ["Morningstar", "https://mcp.morningstar.com/mcp", "oauth"],
    ["Paddle", "https://mcp.paddle.com/mcp", "oauth"],
    ["PayPal", "https://mcp.paypal.com/mcp", "oauth"],
    ["PitchBook", "https://mcp.pitchbook.com/mcp", "oauth"],
    ["Plaid", "https://mcp.plaid.com/mcp", "oauth"],
    ["Ramp", "https://mcp.ramp.com/mcp", "oauth"],
    ["Square", "https://mcp.squareup.com/mcp", "oauth"],
    ["Stripe", "https://mcp.stripe.com/", "oauth"],
    ["Xero", "https://mcp.xero.com/mcp", "oauth", { client: { help: "https://developer.xero.com/app/manage" } }],
  ],
  meetings: [
    ["Cal.com", "https://mcp.cal.com/mcp", "oauth"],
    ["Calendly", "https://mcp.calendly.com/", "oauth"],
    ["Dialpad", "https://mcp.dialpad.com/mcp", "oauth"],
    ["Fathom", "https://api.fathom.ai/mcp", "oauth"],
    ["Fireflies", "https://api.fireflies.ai/mcp", "oauth"],
    ["Granola", "https://mcp.granola.ai/mcp", "oauth"],
    ["Krisp", "https://mcp.krisp.ai/mcp", "oauth"],
    ["Otter.ai", "https://mcp.otter.ai/mcp", "oauth"],
    ["tl;dv", "https://mcp.tldv.io/mcp", "oauth"],
  ],
  hr: [
    ["15Five", "https://mcp.15five.com/mcp", "oauth"],
    ["Greenhouse", "https://mcp.greenhouse.io/mcp", "oauth"],
    ["Remote", "https://mcp.remote.com/mcp", "oauth"],
    ["Workable", "https://mcp.workable.com/mcp", "oauth"],
  ],
  automation: [
    ["IFTTT", "https://ifttt.com/mcp", "oauth"],
    ["Make", "https://mcp.make.com/", "oauth"],
    ["Zapier", "https://mcp.zapier.com/api/v1/connect", "oauth"],
  ],
  web: [
    ["Apify", "https://mcp.apify.com/", "oauth"],
    ["Bright Data", "https://mcp.brightdata.com/mcp", "oauth"],
    ["Exa", "https://mcp.exa.ai/mcp", "none"],
    ["Kiwi.com", "https://mcp.kiwi.com/", "none"],
    ["Mapbox", "https://mcp.mapbox.com/mcp", "oauth"],
    ["Tavily", "https://mcp.tavily.com/mcp", "oauth"],
  ],
  media: [
    ["ElevenLabs", "https://api.us.elevenlabs.io/v1/mcp", "oauth"],
    ["Hugging Face", "https://huggingface.co/mcp", "none"],
    ["invideo", "https://mcp.invideo.io/mcp", "oauth"],
    ["Mux", "https://mcp.mux.com/", "oauth"],
    ["Replicate", "https://mcp.replicate.com/mcp", "oauth"],
    ["Vimeo", "https://mcp.vimeo.com/mcp", "oauth"],
  ],
};

const idOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/\(.*\)/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const CONNECTION_CATALOG: readonly CatalogEntry[] = CATALOG_CATEGORIES.flatMap((category) =>
  ROWS[category].map(([name, url, authType, extra]) => ({ id: idOf(name), name, url, authType, category, ...extra })),
);

/** An address without its trailing slash, query or case of its host: how saved connections are matched to entries. */
function addressKey(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

const byAddress = new Map(CONNECTION_CATALOG.map((entry) => [addressKey(entry.url), entry]));

/** The catalog entry a connection's address belongs to, if any. */
export function catalogEntryFor(url: string): CatalogEntry | undefined {
  return byAddress.get(addressKey(url));
}

/** Entries whose name, address or (translated) category matches every word of the query. */
export function searchCatalog(query: string, categoryLabel: (category: CatalogCategory) => string): CatalogEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...CONNECTION_CATALOG];
  return CONNECTION_CATALOG.filter((entry) => {
    const text = `${entry.name} ${new URL(entry.url).host} ${categoryLabel(entry.category)}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
