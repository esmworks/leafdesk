/**
 * A small Slack export for tests (lib/import/slack.test.ts) and the e2e script
 * (scripts/slack-import-e2e.ts): two people with emails, one without, a bot; a public channel with
 * a thread, a broadcast reply, reactions, a file, a deleted thread start and events; a private
 * channel; a direct conversation that isn't imported. Paths sit in a folder, as Slack zips them.
 */
const encoder = new TextEncoder();

/** `ts` of a moment in 2023, `seconds` after the first message. */
const ts = (seconds: number, micro = 0) => `${1_700_000_000 + seconds}.${String(micro).padStart(6, "0")}`;

export const SLACK_TS = { first: ts(0), thread: ts(60), reply1: ts(120), reply2: ts(180), broadcast: ts(240), tie: ts(240, 1), tombstone: ts(300), orphan: ts(400), secret: ts(500) };

export function slackFixture(emails: { ayse: string; bora: string } = { ayse: "ayse@example.com", bora: "bora@example.com" }): Record<string, unknown> {
  const t = SLACK_TS;
  return {
    "users.json": [
      { id: "U1", name: "ayse", real_name: "Ayşe Kaya", profile: { display_name: "ayse", real_name: "Ayşe Kaya", email: emails.ayse } },
      { id: "U2", name: "bora", profile: { display_name: "", real_name: "Bora Demir", email: emails.bora.toUpperCase() } },
      { id: "U3", name: "cem", profile: { display_name: "Cem", real_name: "Cem Yılmaz" } },
      { id: "B1", name: "deploybot", is_bot: true, profile: { real_name: "Deploy Bot" } },
    ],
    "channels.json": [
      {
        id: "C1",
        name: "general",
        created: 1_699_999_000,
        creator: "U1",
        is_archived: false,
        members: ["U1", "U2", "U3"],
        topic: { value: "Company-wide" },
        purpose: { value: "Everything &amp; anything" },
      },
      { id: "C2", name: "old-project", created: 1_699_999_000, creator: "U2", is_archived: true, members: ["U2"], topic: { value: "" }, purpose: { value: "" } },
    ],
    "groups.json": [{ id: "G1", name: "secret-plans", created: 1_699_999_000, creator: "U2", members: ["U2", "U3"], topic: { value: "" }, purpose: { value: "Only us" } }],
    "dms.json": [{ id: "D1", members: ["U1", "U2"] }],
    "mpims.json": [],
    "general/2023-11-14.json": [
      { type: "message", subtype: "channel_join", user: "U3", text: "<@U3> has joined the channel", ts: ts(-10) },
      { type: "message", user: "U1", text: "Hello *team* &amp; welcome to <#C2|old-project>! :wave: :+1::skin-tone-3:", ts: t.first, reactions: [{ name: "heart", users: ["U2", "U3"], count: 2 }, { name: "partyparrot", users: ["U2"], count: 1 }] },
      {
        type: "message",
        user: "U2",
        text: "Plan for <@U1>: see <https://example.com/plan|the plan> and `<@U3>`",
        ts: t.thread,
        thread_ts: t.thread,
        reply_count: 3,
        edited: { user: "U2", ts: ts(90) },
      },
      { type: "message", user: "U3", text: "Looks good ~mostly~", ts: t.reply1, thread_ts: t.thread, parent_user_id: "U2" },
    ],
    "general/2023-11-15.json": [
      { type: "message", user: "U1", text: "Agreed", ts: t.reply2, thread_ts: t.thread, reactions: [{ name: "thumbsup", users: ["U2"], count: 1 }] },
      { type: "message", subtype: "thread_broadcast", user: "U2", text: "Shipping it <!channel>", ts: t.broadcast, thread_ts: t.thread },
      {
        type: "message",
        subtype: "bot_message",
        bot_id: "B1",
        username: "Deploy Bot",
        text: "",
        ts: t.tie,
        attachments: [{ fallback: "Deployed v1.2" }],
      },
      { type: "message", subtype: "tombstone", text: "This message was deleted.", ts: t.tombstone, thread_ts: t.tombstone, user: "USLACKBOT" },
      { type: "message", user: "U3", text: "Reply under a deleted message", ts: ts(310), thread_ts: t.tombstone },
      { type: "message", user: "U1", text: "Reply to a message the export lacks", ts: t.orphan, thread_ts: ts(-5000) },
      {
        type: "message",
        subtype: "file_share",
        user: "U2",
        text: "The spec",
        ts: ts(450),
        files: [
          { id: "F1", name: "spec.pdf", mimetype: "application/pdf", size: 1234, url_private_download: "https://files.slack.com/files-pri/T1-F1/download/spec.pdf?t=xoxe-secret", permalink: "https://team.slack.com/files/U2/F1/spec.pdf" },
          { id: "F2", mode: "hidden_by_limit" },
        ],
      },
      // The same message again (an export may list it in two days' files): read once.
      { type: "message", user: "U1", text: "Agreed", ts: t.reply2, thread_ts: t.thread },
    ],
    "old-project/2023-11-14.json": [{ type: "message", user: "U2", text: "Done here", ts: ts(10) }],
    "secret-plans/2023-11-16.json": [{ type: "message", user: "U3", text: "Psst", ts: t.secret }],
    "D1/2023-11-14.json": [{ type: "message", user: "U1", text: "Private hello", ts: ts(5) }],
  };
}

/** The fixture's files by path, as unpacked from its ZIP (inside `Slack export/`). */
export function slackFixtureFiles(emails?: { ayse: string; bora: string }): Map<string, Uint8Array> {
  return new Map(Object.entries(slackFixture(emails)).map(([path, json]) => [`Slack export/${path}`, encoder.encode(JSON.stringify(json))]));
}
