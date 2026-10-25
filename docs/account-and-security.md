# Accounts and security

[← README](../README.md) · [All documentation](README.md)

Personal settings, sign-in, and what owners and administrators control.

Contents: [My account](#my-account), [Who can join a workspace](#who-can-join-a-workspace), [Two-step verification and passkeys](#two-step-verification-and-passkeys), [Workspace security switches](#workspace-security-switches), [Single sign-on (OIDC, SAML) and SCIM](#single-sign-on-oidc-saml-and-scim), [Audit log streaming](#audit-log-streaming), [Sensitive content](#sensitive-content).

## My account

"My account" in the workspace menu (or the name and picture at its top) opens `/account`. It
belongs to the person, not to a workspace, so it also works for someone who isn't in any
workspace and isn't held back by a workspace's two-step policy. The old addresses
(`/w/<id>/settings?tab=preferences`, `accountSecurity`, `apps`) redirect to it.

- **Profile:** name (up to 80 characters) and picture. The browser crops the picture to a
  256×256 WebP (PNG where WebP isn't available) before uploading it. PNG, JPEG, WebP and GIF up
  to 2 MB are accepted, checked by their content (SVG never is); pictures are stored with the
  other uploads and shown only to signed-in people. Pictures from GitHub or Google stay until
  someone uploads their own.
- **Email:** the new address gets a link, valid for 24 hours, that makes the change when opened
  and confirmed there (no sign-in needed, and it signs nobody in); the old address is told about
  it. An address another account uses gets no link, and nobody is told so. In production without SMTP
  the option is off and says why (development prints the email to the server log).
- **Password:** change it with the current one, optionally signing out every other device. People
  who only sign in with GitHub or Google can set one instead. Both send a notice by email.
- **Sessions:** every signed-in device with its browser, system, IP address and last activity
  (refreshed about once a day), with "Sign out" per device and "Sign out all other devices",
  which also closes their live collaboration connections. A session ends after
  `SESSION_MAX_AGE_DAYS` without use (see below).
- **Security, connected apps, language and notifications:** as before, moved here from the
  workspace settings.
- **Delete account:** type the account's email to confirm. It is refused while the person is the
  only owner of a workspace others are in (they hand ownership over, or remove the others,
  first). Otherwise workspaces nobody else is in are deleted with their pages and files, and the
  others are left the way leaving works: an owner takes over the pages only this person could
  manage. Sessions, passkeys, connected apps, notifications and the picture go with the account;
  pages and comments the person wrote in the remaining workspaces stay.

Changing the email or password and deleting the account ask for the password again, or for a
two-step code (or recovery code) on accounts without one. An account with neither needs a
sign-in from the last 10 minutes. These checks are rate-limited per person (10 tries per 15
minutes), as are email changes (5 an hour), picture uploads (20 an hour) and signing out devices.

How long a sign-in lasts is set for the whole server:

| Variable | Meaning |
| --- | --- |
| `SESSION_MAX_AGE_DAYS` | Days a session lasts, in whole days from 1 to 400. Default `7`. More than 400 is read as 400, the longest a browser keeps the session cookie. A session in use is extended (about once a day, or halfway through for a one-day lifetime), so this is how long a device may sit unused before it has to sign in again. Existing sessions keep the expiry they have until they are next extended. |

## Who can join a workspace

Owners decide in the workspace's **Settings → Security → Members**. Where an owner approves or
declines below (join requests, members' additions waiting for approval), a membership admin may
too; join requests reach them in the inbox and by email like owners.

- **Who can add members:** *Owners only* (default), *Members, with an owner's approval*, or
  *Owners and members*. Members add people as members only, never as owners or guests. With
  approval, what a member adds (one address or several) becomes a request, and the invitation
  (with its email) goes out in the member's name once an owner approves it. Guests never add
  anyone. The same rule applies wherever members are added, in the app and through MCP's
  `invite_member` (a member's invitation there becomes a request the same way); the REST API
  only lists members.
- **Allowed email domains** (`example.com, example.org`, subdomains included, up to 20; public
  mail services such as gmail.com can't be added). A domain does nothing until the workspace
  proves it is its own, as for single sign-on: add the TXT record shown next to it
  (`_leafdesk-sso.<domain>` with the value `leafdesk-sso=<token>`, a token of the workspace's
  own) at your DNS provider and click **Verify**. Until then nobody joins, asks to join or sees
  the workspace through it. A domain the workspace's single sign-on connection verified counts
  without a record, subdomains included. A domain another workspace verified (for single sign-on
  or as an allowed domain) can't be verified, and a domain taken off the list has to be verified
  again. The token is derived from `BETTER_AUTH_SECRET`: a new secret changes the value to add
  for domains not verified yet, never a verified one.
- What happens **when someone from these domains signs in**: they *join as members* (default) or
  *ask to join*. This runs on sign-up, on every sign-in and when an address is verified or
  changed, once per person and workspace: someone who left, or whom an owner removed or declined,
  doesn't come back on their own. Only verified addresses count (see [Email](self-hosting.md#email) for how an
  address is verified, with and without SMTP). The workspace switcher also lists the workspaces a
  person's domain lets them join or ask to join, with a Join or Request to join button: people
  who left may rejoin there, people who were removed or declined may only ask.
- **Who can ask to join:** *Nobody* (default), *People with an allowed email domain* (a verified
  domain; their own address may be unverified, and people removed or declined before may ask
  too), or *Anyone with the join link*. With the last one the join link asks an owner instead of
  adding people right away, except for people with a pending invitation or a verified address on
  an allowed domain that joins directly.

Requests wait in **Settings → Members → Requests**, where owners approve or decline them; every
owner also gets one in their inbox (and by email, unless they turned join request emails off in My
account → Preferences). The person who asked hears the decision by email, in their language (see
Languages), else the one they asked in. There is one pending request per person and workspace (and per invited address), and
people may send 10 requests an hour, members 100 invitation requests an hour.

## Two-step verification and passkeys

Everyone manages these in **My account → Security**:

- **Authenticator app (TOTP):** scan a QR code (or type the key) into an app such as 1Password
  or Google Authenticator and confirm with a code. Ten recovery codes are shown once, to copy or
  download; each signs in once, and "New codes" replaces them. From then on, signing in with the
  password *or* with GitHub/Google asks for a code; "Don't ask again on this device" skips it for
  30 days. Turning it off asks for the password, or, for accounts without one, a code.
- **Passkeys:** add, rename and remove them; "Sign in with a passkey" is on the sign-in page.
  Passkeys are bound to the host name of `APP_URL`, so changing that host makes existing
  passkeys stop working. Adding one needs a sign-in from the last 24 hours.

Owners can turn on **Require two-step verification** in the workspace's **Settings → Security**.
A session passes when the person has the authenticator app on, or signed in with a passkey;
anyone else who opens the workspace is sent to a page where they set one of them up first
(nobody is locked out, owners included). An owner can only turn the policy on from a session
that passes it. The policy covers everything a browser session reaches: the app's pages, exports,
server actions, API routes (files, import) and the live collaboration connection, which is
checked when it connects; turning the policy on closes the open connections of sessions that
don't pass. Apps connected over MCP and REST API tokens are not affected: they use OAuth or
personal access tokens, not sign-in sessions, and keep working until someone revokes them under
Connected apps.

**Approved networks** (Settings → Security) limit where a workspace opens from: a list of IPv4 and
IPv6 addresses and CIDR ranges (`203.0.113.0/24`, `2001:db8::/32`), each with an optional label, at
most 100. While the list has entries, a browser session from any other address is sent to a page
that says the workspace only allows sign-in from approved networks and shows the address the server
sees; the person's other workspaces keep working. It covers the same ground as two-step
verification (pages, exports, server actions, API routes, the live collaboration connection, which
is checked by the address it comes from), applies to everyone in the workspace, owners and guests
too, and comes before the other policies. A request whose address the server can't tell counts as
outside the list. The address is the visitor's as `TRUSTED_PROXIES` reads it (see *Quick start
(Docker)* above), so set that right before relying on this. An owner can't save a list that leaves
out their own current address; if a list shuts everyone out anyway (a new office line, a proxy set
up differently), an instance administrator clears it on `/admin` under *Approved networks*.
Changes go into the audit log. Apps connected over MCP, REST API tokens and SCIM tokens are not
held to the list: they follow the connected-apps setting. A restored backup starts without one,
since its addresses were the old server's view. Not offered when Leafdesk runs on one computer.

Someone who lost both their authenticator app and their recovery codes can be reset by whoever
runs the server; this turns two-step verification off and signs them out (`--passkeys` also
removes their passkeys):

```bash
pnpm auth:reset-2fa person@example.com
# Docker: docker compose exec app tsx scripts/reset-two-factor.ts person@example.com
```

## Workspace security switches

Owners decide in the workspace's **Settings → Security** what may leave the workspace. The
server enforces each switch everywhere it applies: in the app, on public pages, over MCP and in
the REST API.

- **Publishing:** *Owners only*, *Owners and members*, or *Off*. Off stops serving everything the
  workspace has published: published pages, their files, the workspace site and public forms
  answer "not found", and nobody can publish or duplicate them. Nothing is deleted: the
  publications and the site's settings stay listed in Settings, and come back as they were when
  publishing is turned on again.
- **Export:** on by default. Off removes Markdown, CSV, ZIP and PDF export (and the print view)
  for everyone, owners included, and the export routes answer `403`. Calendar feeds stop, and
  automations can't get a webhook, HTTP request or Send to Slack step nor send one (`webhookExportOff`; one
  saved before may stay, and its runs and test pings fail until export is back on). The member list CSV in
  Settings → Members stays, as it is an owner's own administration tool.
- **Connected apps and API tokens:** what MCP apps and personal access tokens may do in the
  workspace, on top of their own permissions and their user's access. *Full access* (default),
  *Read only* (write tools and write endpoints are refused, reads still work), or *Off* (the
  workspace is hidden from them: `list_workspaces` and `GET /workspaces` leave it out, and its
  pages answer as pages the user can't see). This applies to the MCP server, the REST API and the
  AI chat from Telegram (read only: it answers without changing anything); the app itself in the
  browser is not affected.
- **Only approved apps:** off by default. On, only the MCP apps an owner approved in *Apps that
  reach this workspace* below reach the workspace; to every other app it is hidden, as with *No
  access*, whoever connected it. An approval is the app's (its OAuth client), so it covers everyone
  here who connects that app. The server's own clients and REST API tokens aren't held to it. The
  consent screen tells someone connecting an app which of their workspaces it won't reach until an
  owner approves it.
- **Apps that reach this workspace** (owners): the MCP apps the workspace's people connected and
  their API tokens for it (for all their workspaces or this one; expired ones and the server's
  own clients are left out), with what each may do, who connected it, when, and when it last
  reached this workspace (recorded at most once a minute, from when this list was added, for
  requests the workspace let through). It shows the 100 apps and 100 tokens used here most
  recently, and how many there are in all. *Disconnect* (an app) and *Revoke* (a token) take it from
  that person's account: an app or a token belongs to the person, so it stops reaching all of their
  workspaces until they connect it again or make a new token. Only this workspace's audit log
  records it, with the owner as who did it and the person it was about.
  *Approve* and *Withdraw approval* on an app decide whether it reaches the workspace while *Only
  approved apps* is on (a workspace keeps at most 500 approvals); both are recorded in the audit log.

- **People from your domains** (owners, once the workspace has verified email domains): every
  account on the server with an address in those domains or their subdomains, whether it is in
  the workspace (and as what) or not, when it was last active (from its sessions, renewed once a
  day while in use) and how it signs in (password, single sign-on, passkey, social login). Those
  outside are added with the usual *Add members* step and members are removed as in Settings →
  Members. Up to 500 are listed; agents are left out.

## Single sign-on (OIDC, SAML) and SCIM

Organizations can sign people in through their own identity provider (Keycloak, Authentik, Okta,
Microsoft Entra ID, Google Workspace…) in two ways, which can be combined:

- **For the whole server** (the operator's provider, OpenID Connect): set the variables below and
  restart. The sign-in page gets a "Continue with `OIDC_NAME`" button.
- **Per workspace** (OpenID Connect or SAML 2.0): an owner sets it up in **Settings → Security →
  Single sign-on**. People sign in with it through **Continue with SSO** on the sign-in page,
  where they type their email and are sent to their organization's provider.

| Variable | Meaning |
| --- | --- |
| `OIDC_ISSUER` | Issuer URL; its discovery document must be at `<issuer>/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The client registered at the provider (confidential, authorization code flow) |
| `OIDC_NAME` | Button label (default `SSO`) |
| `OIDC_DOMAINS` | Comma-separated email domains the provider is authoritative for (optional, see below) |
| `SSO_TRUSTED_ORIGINS` | Comma-separated origins of workspace providers on a private network (the instance issuer's is trusted already) |

The instance provider's redirect URI is `${APP_URL}/api/auth/sso/callback/oidc`. The scopes asked
for are `openid email profile`, with PKCE.

**What single sign-on does**

- **First sign-in creates the account.** Through a workspace connection, only for addresses in
  its verified domains; the person also joins that workspace as a member. So does an existing
  account on its first sign-in through the connection. Only then, and not someone who left the
  workspace or whom an owner removed, even when a new connection makes their next sign-in the first
  again: their provider can bring them back over SCIM, or an owner by adding or inviting them
  again. Through the instance provider, for anyone it signs in, or only
  for `OIDC_DOMAINS` when those are set; it creates accounts even with `DISABLE_SIGNUP=true`,
  since the operator configured it. Set `OIDC_DOMAINS` for a provider that signs in people outside
  your organization (Google does).
- **Existing accounts** with the same email are signed in only when the provider is authoritative
  for the address: a workspace connection for its verified domains, the instance provider for
  `OIDC_DOMAINS`. Like social login, an account whose email was never verified loses its password
  and its earlier sessions when this happens (see [Social login](self-hosting.md#social-login)).
- **Two-step verification still applies:** someone with an authenticator app is asked for a code
  after the provider, as with a password.

**Setting up a workspace connection** (owners): the SSO box shows what to enter at the provider,
each with a copy button: the workspace ID, the **OIDC redirect URI**
(`${APP_URL}/api/auth/sso/callback/ws-<workspace id>`), the **SAML entity ID** (audience), the
**ACS URL** (`${APP_URL}/api/auth/sso/saml2/sp/acs/ws-<workspace id>`) and the SAML metadata URL.
Then fill in the provider's details:

- **OpenID Connect:** issuer URL, client ID and client secret. The issuer's discovery document is
  read when saving (it must name the same issuer, and its endpoints must be https unless the
  origin is in `SSO_TRUSTED_ORIGINS`). Addresses on private networks are refused unless trusted.
- **SAML 2.0:** paste the provider's metadata XML, or enter its SSO URL, entity ID and signing
  certificate. Assertions must be signed; the NameID format asked for is the email address.
  Single logout is not supported.
- **Email domains** (`example.com, example.org`; subdomains included): the connection signs
  nobody in until they are verified. Add the TXT record it shows for each domain
  (`_leafdesk-sso.<domain>` with the value `leafdesk-sso=<token>`) at your DNS provider and click
  **Verify domains**. Public mail services (gmail.com, outlook.com…) can't be claimed, and a
  domain verified by one workspace (for single sign-on or as an allowed email domain, or listed in
  `OIDC_DOMAINS`) can't be verified by another. Verified domains also count as verified allowed
  email domains of the workspace.
  Changing the domains or the provider asks for verification again. A change saved while
  **Verify domains** waits for DNS makes it fail and ask to verify again (only the domains and
  provider that were looked up are verified), as does another workspace verifying one of the
  domains meanwhile.

A workspace has one connection. Removing it, pointing it at another identity provider, or deleting
the workspace signs out everyone who signed in through it and revokes their API tokens and
connected apps, which reach all their workspaces; removing it (or the workspace) also removes its
provider.

Deleting the account of the last person in a workspace deletes the workspace too, and with it the
connection: everyone who signed in through it is signed out and their API tokens and connected apps
are revoked. A new connection starts with nobody linked to it: people are linked again by their
address when they next sign in through it (see *Existing accounts* above). A connection doesn't go
with the account of the owner who set it up: another owner of the workspace takes it over.

**How members sign in** (Settings → Security): *Any method* (default) or *Single sign-on only*.
With single sign-on only, members whose session didn't come through the workspace's connection
(or the instance provider) are sent to a page that signs them in with it, and like two-step
verification the policy covers the app's pages, exports, server actions, API routes and live
collaboration, and closes open connections when turned on. **Owners and guests are exempt**, so a
broken identity provider can't lock a workspace: owners keep their password or passkey. It can be
turned on only once a verified connection (or the instance provider) exists. Apps connected over
MCP and REST API tokens are not affected.

**SCIM 2.0 provisioning.** Owners create SCIM tokens in Settings → Security (shown once, stored
as a SHA-256 hash, at most 20 per workspace, 600 requests a minute each) and give the provider the
base URL `${APP_URL}/scim/v2` with the token as a bearer token. Supported:

- `/Users`: list (with `startIndex`/`count` and one `eq` filter on `userName`, `externalId`,
  `emails.value` or `id`), get, create (`POST`), replace (`PUT`), `PATCH` (`active`,
  `externalId`, `displayName`, `name`; `userName` and `emails` are ignored: an account's address
  is its owner's) and delete.
- Users are the workspace's owners and members, plus people the provider deactivated. Creating a
  user makes them a member (a guest is promoted); a new account is created only for addresses in
  the workspace's verified SSO domains, anyone else must have an account already, with a verified
  address (an unverified one is refused until its owner verifies it). Names are changed only for
  addresses in those domains.
- `active: false` removes the person from the workspace (what an owner removing them does) and
  keeps them listed as inactive; they can't come back through single sign-on until reactivated.
  `DELETE` removes them and forgets them. Owners can't be deactivated or deleted over SCIM.
- `/Groups` are the workspace's [member groups](features.md#features), all of them, including ones made in
  the app: list (with `startIndex`/`count`, one `eq` filter on `displayName` (ignoring case),
  `externalId` or `id`, and `excludedAttributes=members`), get, create (`POST` with
  `displayName`, `externalId`, `members`), replace (`PUT`; `members` and `externalId` it leaves out
  are kept, `members: []` empties the group), `PATCH` and delete. `PATCH` takes what Okta and
  Microsoft Entra ID send: `add`/`remove`/`replace` on `members` (a `remove` without a value
  empties the group), `remove` on `members[value eq "<user id>"]`, `displayName` and `externalId`
  paths, and path-less operations with an object value; op names in any case.
- Group members are SCIM user ids of the workspace's owners and members. Guests, people the
  provider deactivated, other people and nested groups are refused with 400 `invalidValue`, and
  nothing in that request is applied. A name another group has (ignoring case) is a 409
  `uniqueness`.
- Group changes go through the same code as Settings → Groups: access is worked out again, open
  editors of people who lost a page close, and pages only the group could manage pass to someone.
  A SCIM token isn't a person, so the workspace's **oldest owner** acts for it: they receive those
  pages (as they do when the provider removes a member) and are recorded as having created the
  groups the provider creates. Settings → Groups marks groups the provider created or changed
  ("From your identity provider"); owners can still edit them, but the provider may undo that at
  its next sync. Someone made a guest in the app leaves their groups, and the provider adding them
  back is refused.
- `/ServiceProviderConfig`, `/ResourceTypes` and `/Schemas` (User and Group attributes) for
  discovery.

**Examples**

- **Keycloak** (OIDC): create a client with *Client authentication* on and the standard flow,
  add the redirect URI from the SSO box (or `…/sso/callback/oidc` for the instance provider). The
  issuer is `https://keycloak.example.com/realms/<realm>`. Keycloak in the same Docker network:
  `SSO_TRUSTED_ORIGINS=http://keycloak:8080`. For SAML, import the SSO box's metadata URL as a
  SAML client and paste the realm's descriptor
  (`…/realms/<realm>/protocol/saml/descriptor`) as the metadata XML.
- **Authentik** (OIDC): create an *OAuth2/OpenID Provider* (confidential client, redirect URI from
  the SSO box) and an application using it; the issuer is
  `https://authentik.example.com/application/o/<application slug>/`. SCIM: add a *SCIM Provider*
  with the base URL and a SCIM token, and attach it to the application as a backchannel provider.
- **Google Workspace**: as the instance provider (OIDC), create an OAuth client of type *Web
  application* in Google Cloud with the redirect URI `${APP_URL}/api/auth/sso/callback/oidc`, set
  `OIDC_ISSUER=https://accounts.google.com` and `OIDC_DOMAINS=<your domain>` (Google signs in any
  Google account otherwise). Per workspace, use SAML: add a *custom SAML app* in the Admin console
  with the ACS URL and entity ID from the SSO box, *Name ID format* EMAIL with the primary email,
  and paste the IdP metadata it offers. Google Workspace doesn't send SCIM to custom apps.

Tested here against a mock OpenID Connect provider (`scripts/sso-e2e.ts`) and over HTTP for SCIM
(`scripts/scim-e2e.ts`, which sends groups the way Okta and Entra ID document it); SAML, SCIM from
Okta or Entra ID and the providers above have not been tried against the real thing.

## Audit log streaming

Owners send the workspace's audit events to their own collector (a SIEM, a log pipeline) in
**Settings → Audit log → Stream to your security tools**: an HTTPS address, and a signing secret
that is shown once (kept sealed with `LEAFDESK_ENCRYPTION_KEY`, like connections' secrets) and can be
replaced. Addresses get the same checks as automation webhooks: https only, public addresses only,
no redirects, ten seconds per request; hosts in `AUTOMATION_WEBHOOK_ALLOWED_HOSTS` may use http and
private addresses.

Each event recorded while the stream is on is sent once it goes through, **at least once and in
order**: batches of up to 100 events, oldest first, sent when 100 wait or the oldest has waited 30
seconds. A batch that fails (a network error or an answer other than 2xx) is tried again after 30
seconds, then 1, 2, 5, 15 and 30 minutes, then every hour, with the same delivery id and the events
waiting by then; events still unsent after 7 days are given up on and counted. Events recorded
while the stream is off are not sent later. The settings show whether it is streaming or failing
(since when, the last error and the next try), the last delivery, how many events were sent and
how many wait, and *Send test event* sends one made-up event right away.

Each batch is a `POST` with `Content-Type: application/json` and these headers:

- `X-Leafdesk-Event`: `audit.events` (`ping` for a test)
- `X-Leafdesk-Delivery`: the batch's id, the same each time it is tried again
- `X-Leafdesk-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>`

```json
{
  "id": "4f0c2c1e-…",
  "type": "audit.events",
  "workspace_id": "…",
  "sent_at": "2026-10-24T10:00:30.000Z",
  "events": [
    {
      "id": "…",
      "time": "2026-10-24T10:00:01.123Z",
      "action": "member.role_changed",
      "category": "members",
      "actor": { "kind": "user", "id": "…", "name": "Ada", "email": "ada@example.com", "via": null, "ip": "192.0.2.1", "user_agent": "…" },
      "target": { "type": "user", "id": "…", "label": "Bob" },
      "details": { "from": "member", "to": "owner" }
    }
  ]
}
```

A test carries `"type": "ping"` and `"test": true`. `actor.kind` is `user`, `agent`, `api_token`,
`connected_app`, `scim`, `system` or `automation` (`via` names the token, app or automation);
`category` is the Settings filter's group, or null for an action the version doesn't know. Page
events add `target.audience`, who could reach the page then: `{"kind": "web"}`, `{"kind":
"workspace", "teamspace"?: "General"}`, `{"kind": "teamspace", "teamspace": "Sales"}`, `{"kind":
"people", "people": 2, "groups": 1}` or `{"kind": "private"}`; the CSV has it as its last column. New
versions add actions: keep the ones you don't know. Check the signature against the raw body and
refuse old timestamps; an event can arrive twice (a batch whose answer was lost is sent again), so
keep the first of each event `id`.

The same events can be read with the REST API: `GET /workspaces/{id}/audit-log` (scope
`audit:read`, which only a workspace's owners can give, and only to a token limited to that
workspace) filters by `since`, `until`, `actor_id`, `actor_kind`, `action` and `category`, newest
first or `order=asc`, up to 500 at a time with `next_cursor`. The token stops reading once its
person is no longer an owner.

## Sensitive content

Owners turn on **Look for sensitive content** in Settings → Security (off by default). A
background job then reads the title, body and row values of the workspace's pages once they
change (templates and the trash aren't read; turning it on reads every page once) and looks for:

- payment card numbers of the known issuers that pass the Luhn check, compact or in groups;
- IBANs with their country's length and a valid mod-97 check;
- Turkish national ID numbers (T.C. kimlik no) with both check digits right;
- private keys (PEM blocks), AWS access keys, GitHub and Slack tokens, `sk-` style API keys,
  live payment-provider keys, Google API keys, Leafdesk API tokens and JSON Web Tokens.

The value itself is never kept: a finding holds its kind, a masked excerpt (`**** **** **** 4242`,
`TR** **** **** 1326`, `ghp_…3f9a`) and a keyed hash to know it again. Each finding is recorded in
the audit log, and owners get an inbox notice for a page and kind at most once a day. Settings →
Security lists the open findings with links to their pages and a *Dismiss* button; a finding
resolves itself once the page no longer holds the value, and opens again if it comes back (a
dismissed one stays dismissed). Turning detection off deletes the findings.
