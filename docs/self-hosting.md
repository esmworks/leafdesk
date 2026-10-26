# Running a server

[← README](../README.md) · [All documentation](README.md)

Settings for running Leafdesk on your own server, beyond the [quick start](../README.md#quick-start-docker).

Contents: [File uploads](#file-uploads), [Email](#email), [Push notifications](#push-notifications), [Social login](#social-login), [Maps and places](#maps-and-places), [Instance administrators](#instance-administrators), [Deploy on Dokploy](#deploy-on-dokploy).

## File uploads

Images, video, audio and other files added to pages are stored on disk in `UPLOAD_DIR`
(`./data/uploads` by default). With Docker Compose that directory is the `uploads` volume, so
back it up together with the database. To use S3-compatible storage (AWS S3, Cloudflare R2, MinIO)
instead, set `S3_BUCKET` and its credentials; files already stored are not moved when you switch.

| Variable | Meaning |
| --- | --- |
| `UPLOAD_DIR` | Where files go with local storage. Default `./data/uploads`. |
| `UPLOAD_MAX_FILE_MB` | Largest file, in MB. Default `50`. |
| `UPLOAD_WORKSPACE_QUOTA_MB` | Most one workspace may store, in MB. Default `10240`; `0` means no limit. |
| `S3_BUCKET` | Store files in this bucket instead of on disk. |
| `S3_ENDPOINT` | The service's URL for R2, MinIO and others, e.g. `https://<account-id>.r2.cloudflarestorage.com`. Leave out for AWS S3. |
| `S3_REGION` | Default `us-east-1` (R2 accepts it too). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Credentials allowed to put, get and delete objects in the bucket. |
| `S3_FORCE_PATH_STYLE` | Address the bucket by path (`<endpoint>/<bucket>/…`). Default `true` with `S3_ENDPOINT`, `false` for AWS. |
| `S3_PREFIX` | Optional folder inside the bucket. |

Limits are enforced while a file arrives. A file can be opened by anyone who can see the page it
was uploaded to or a page of the same workspace showing it (so duplicates and pages made from
templates share it), or a row whose files & media property holds it, and by visitors of a
published page showing it. A page shows a file this way only when whoever put it there could open
the file already: pasting or typing a file's link into a page (in the editor, through the API, MCP
or an import) lets nobody open a file the writer couldn't, and the page's export and copies leave
it out too. A file a row holds only in a files & media property hidden from someone (property
access) doesn't open for them through that row. Only raster images, video,
audio and PDF open in the browser; everything else, SVG included, is downloaded. When a page is
deleted for good, its files go once no other page shows them, and uploads no page ever used are
removed after a day (uploads for a form's answer that was never sent after two hours). Uploads to
a public form are limited per IP address and per form, in number and in size: at most 256 MB an
hour from one address, and 1 GB waiting to be sent in one database. When files go this way, or with a deleted workspace or account, the stored
objects to delete are queued in the same transaction that removes their records, and what storage
refuses is tried again by the hourly file cleanup, waiting longer after each failure (up to a
day), so no bytes stay behind with nothing pointing at them.

The file viewer shows files without changing how they are served. Images, SVG included, show as
pictures (`<img>`), so an SVG's scripts don't run. Text, CSV, Markdown, JSON and code are read
with `fetch` (the first 2 MB) and shown as text, a table or formatted Markdown without its raw
HTML, never as a page of their own. Word documents (.docx, up to 25 MB) are turned into cleaned-up
HTML on the server by `GET /api/files/<id>/preview`, which answers only people who may open the
file; their pictures are inlined (up to 3 MB each, 12 MB in all) and links keep only `http`,
`https` and `mailto` addresses.

### A workspace's own storage

By default every upload goes to the server's storage (S3 or `UPLOAD_DIR`, see above). Setting
`OWN_STORAGE_ENABLED=true` lets people keep the files of workspaces they own in storage of their
own instead. While it is off (the default) nobody can connect or attach storage and nothing about
it is shown, except to workspaces connected before it was turned off: those keep storing and
serving their files there, and the server's startup line says how many there are.

**Connected once, used in every workspace.** Storage is connected to one's own account, under
**Account → Apps → Connected storage**: an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze
B2, MinIO and the like) with its endpoint, region, bucket, an optional folder, and an access key
that may put, get and delete objects there, or a sign-in to Google Drive or Dropbox (below). Before
anything is saved, Leafdesk stores a test file, reads it back whole and in part, and deletes it.
The first storage one connects becomes their default, which new workspaces they make (also by
restoring a backup) use from the start. In a workspace's **Settings → Storage**, an owner
picks one of their own storage accounts for it, or connects another there; each workspace gets a
place of its own in it (a folder of its own in Drive, its own key prefix in a bucket or Dropbox).
Only the person whose storage it is can attach it to a workspace; the other owners see whose it
is. Connected storage can be renamed, tried again, made the default or disconnected; disconnecting
asks first and names the workspaces still using it.

From then on the workspace's new uploads go there and count against no `UPLOAD_WORKSPACE_QUOTA_MB`
(the per-file limit still applies); other workspaces keep the server's storage and its quota.
Files are still served by Leafdesk at `/api/files/<id>` with the same access checks, so the bucket
stays private: no public access, presigned links or CORS settings are needed, and the workspace's
other members need no account with the storage. The keys are stored encrypted
(`LEAFDESK_ENCRYPTION_KEY`) and never shown again. A request the storage refuses (revoked keys, a
deleted bucket, a revoked sign-in) marks it as not working, with the storage's answer, in both
settings, where the workspace's owners are told to try it again or restore the files from a backup;
uploads then fail instead of landing on the server, and the next request that works, or **Test
again**, clears it.

**Files move when the storage's owner goes.** When the person whose storage holds a workspace's
files leaves the workspace, is removed from it, deletes their Leafdesk account or disconnects the
storage, the files are moved in the background: to the default storage of the workspace's
longest-standing other owner that has one that works, or else to the server's storage, but only
when that is S3 and the files fit the workspace's quota there. They are never copied onto the
server's own disk. With nowhere to go, leaving (or deleting one's account) is refused with the
workspace named, so they can ask an owner to set up storage or move the files first; someone
removed is removed anyway, and the owners see the move blocked until there is somewhere to go and
they try it again. Owners can also move all of a workspace's files themselves, under **Move
files**, to their own storage or (when it may take them) the server's.

A move streams each file across and points it at the copy a few files at a time, so every file
stays readable throughout, and the storage being left keeps serving files and taking new uploads
(with the leaver's credentials, also after their account is deleted) until the destination takes
over. The old copies are deleted only once every file is across. Progress and any file that
couldn't be copied show in Settings → Storage, where a failed move can be tried again; a move
picks up where it was after a restart. Storage that holds none of a workspace's files any more is
forgotten, keys and all. Deleting a workspace deletes its files from every storage they are in. A
workspace backup carries its files' bytes but not the storage: a restored workspace uses its
restorer's default storage for new uploads, and stores the restored files on the server.

For a shared workspace, prefer storage that belongs to the team (a company bucket, or the Drive of
an account the team controls) over someone's personal Drive: files then stay put when people
come and go. A personal Drive or Dropbox suits a workspace one keeps to oneself.

The endpoint is one a person typed, so it is held to the rules connections follow: https only, a
public address only (the address is checked when connecting and the connection pinned to it), and
no redirects. List storage on your own network in `STORAGE_ALLOWED_HOSTS` (comma-separated, a host
name or host:port; plain http allowed for those), e.g. `STORAGE_ALLOWED_HOSTS=minio:9000`.

#### Google Drive and Dropbox

One can also sign in to **Google Drive** or **Dropbox**, from Account → Apps or from a
workspace's Settings → Storage; the browser comes back where it began, and the storage is tried
with a test file before it is kept, as for a bucket. Leafdesk asks for as little as it can:

- **Google Drive** with the `drive.file` scope: Leafdesk sees only the files and folders it made.
  It makes a folder "Leafdesk" in the person's Drive and in it a folder "Leafdesk (<workspace
  name>)" for each workspace using it; signing in again to the same account keeps the same folders.
- **Dropbox** as an *App folder* app: Leafdesk reaches only `Apps/<your app's name>` and keeps each
  workspace's files there under the workspace's own path.

Each needs an app the server's administrator registers once, with
`<APP_URL>/api/storage/oauth/callback` as its redirect URI:

- Google Cloud console: enable the Google Drive API, configure the OAuth consent screen with the
  `https://www.googleapis.com/auth/drive.file` scope, and create an OAuth client of type *Web
  application*. Set `STORAGE_GDRIVE_CLIENT_ID` and `STORAGE_GDRIVE_CLIENT_SECRET`.
- Dropbox App Console: create a *Scoped access* app with *App folder* access and the permissions
  `account_info.read`, `files.content.read` and `files.content.write`. Set its app key and secret
  as `STORAGE_DROPBOX_CLIENT_ID` and `STORAGE_DROPBOX_CLIENT_SECRET`.

Drive and Dropbox are offered only once both values of one are set (S3 always is, while own
storage is on); until then the server's administrators, and only they, see a note naming them. The sign-in's
tokens are stored encrypted; access tokens are refreshed as they run out and the refreshed ones
kept. When the owner revokes Leafdesk's access in their Google or Dropbox account (or the app's
values change), the storage shows as not working, with the provider's answer, until someone signs
in again. Uploads are streamed, with no file held in memory; a Dropbox file
over 150 MiB goes up in 8 MiB parts.

## Email

Email is needed for invitations and password reset. Set these in `.env`:

| Variable | Meaning |
| --- | --- |
| `SMTP_URL` | Connection URL, e.g. `smtp://user:password@smtp.example.com:587`. Use `smtps://` for implicit TLS on port 465. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | Alternative to `SMTP_URL`. The port defaults to 587 (STARTTLS), or 465 with `SMTP_SECURE=true`. |
| `MAIL_FROM` | Sender, e.g. `Leafdesk <no-reply@example.com>`. Required when SMTP is set. |

Check the settings with `pnpm mail:test you@example.com`. In Docker, run
`docker compose exec app tsx scripts/send-test-email.ts you@example.com`. The server also logs
its mail setup at startup.

Without SMTP, development prints emails to the server log. In production, features that need
email say that it is not configured.

With email available (SMTP, or the development log), new email and password accounts get a link
that verifies their address, and My account → Profile can send it again. Verified addresses matter
for workspaces that let their [email domains](account-and-security.md#who-can-join-a-workspace) in, and for being added
to a workspace or a page by email (an unverified account gets an invitation instead). In
production without SMTP no link is sent, and only accounts whose provider vouches for the address
(GitHub, Google, single sign-on, SCIM) count as verified.

Anyone can sign up with someone else's address, so following the verification link in a browser
that isn't signed in to the account also takes the account over from whoever signed up: its other
sessions end, its password has to be replaced through a reset link emailed to the address before
it signs in again, and its passkeys, two-step verification, API tokens and connected apps go.
Following the link where you signed up (still signed in) changes nothing.

## Push notifications

New inbox items can also come as system notifications on people's devices, while Leafdesk is
closed too. Each person turns them on per device in My account → Preferences ("Push notifications
on this device"), and picks there, per kind of notification, whether it comes as a push next to
the inbox and email. Push follows the inbox: a kind kept out of the inbox isn't pushed. Opening a
notification brings an open Leafdesk tab to the page, or opens one; its "Mark as read" button
marks the inbox item read (its email, if still to come, then doesn't go) and its "Snooze 1 hour"
button puts it off as the inbox's snooze does (not on agents' requests to go ahead, which wait
only so long). People who linked Telegram get the same notifications there too (see
[AI chat from Telegram](ai.md#ai-chat-from-telegram)), with a Telegram column of their own.

Push is off until the server has a VAPID key pair. Make one and add the printed lines to `.env`:

```bash
pnpm push:keys mailto:ops@example.com
# Docker: docker compose run --rm app tsx scripts/generate-vapid-keys.ts mailto:ops@example.com
```

| Variable | Meaning |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | The key pair the server signs push messages with. Keep the private key secret. |
| `VAPID_SUBJECT` | An address the browsers' push services can reach you at: `mailto:` or `https:`. |
| `PUSH_ALLOWED_HOSTS` | Optional. Push services on a private network or plain http that push may reach (a push service run next to the server), comma-separated as a host name or `host:port`. |

Without all three VAPID values push is off and its settings are hidden. Changing the keys stops
push on every device until it is turned on there again. Push needs the service worker, so it works
in production builds over HTTPS (or `localhost`), not under `pnpm dev`. On iPhone and iPad, Safari
delivers push only to the installed app (Add to Home Screen).

A push message carries only what the inbox shows for the notification (the page's name, who did
what; for a followed row, the names of the values that changed, not what they changed to), checked against the recipient's access like the inbox, in their language. It is encrypted
for the browser, and push services keep it a day at most. A device's subscription belongs to the
sign-in it was made in: signing out, or the session being revoked or running out, stops it. The
endpoints come from browsers, so the server sends only to public https addresses on port 443,
checked before every send with the connection pinned to the checked address; hosts in
`PUSH_ALLOWED_HOSTS` skip that check. A push service that says a subscription is gone gets it
deleted, and one that fails 10 times in a row has it dropped.

## Social login

People can also sign in with GitHub, Google or Apple. Each provider is off until you set its
variables in `.env` and restart:

| Provider | Variables | Callback URL to register |
| --- | --- | --- |
| GitHub ([new OAuth app](https://github.com/settings/applications/new)) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `${APP_URL}/api/auth/callback/github` |
| Google ([OAuth client](https://console.cloud.google.com/apis/credentials), type "Web application") | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `${APP_URL}/api/auth/callback/google` |
| Apple ([Services ID](https://developer.apple.com/account/resources/identifiers/list/serviceId) with Sign in with Apple, and a key for it) | `APPLE_CLIENT_ID` (the Services ID), and `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the .p8 file's text) or `APPLE_CLIENT_SECRET` | `${APP_URL}/api/auth/callback/apple` (Apple wants an https address, and the domain registered with the Services ID) |

For example, with `APP_URL=https://notes.example.com` the GitHub callback URL is
`https://notes.example.com/api/auth/callback/github`. The sign-in and sign-up pages show a
"Continue with …" button for each configured provider. Apple's client secret is a token that
Apple accepts for six months at most: given the key, the server makes it and makes a new one
before it runs out; one set in `APPLE_CLIENT_SECRET` is used as it is, and must be renewed by hand.
Apple gives a person's name only the first time they sign in, and may give an address that
forwards to theirs (`…@privaterelay.appleid.com`) when they choose to hide their own.

- **Existing accounts:** signing in with a provider opens the account that has the same email,
  as long as the provider says the address is verified. Otherwise the person is asked to sign in
  with their password. If that account's email was never verified, signing in this way also
  removes its password and signs out its other sessions and connected apps: anyone could have
  registered the address before its owner did. The owner can get a password back with "Forgot
  password", which proves the address by email.
- **Closed sign-up:** with `DISABLE_SIGNUP=true`, a provider signs in only people who already
  have an account, or who were invited with that email. It never creates other accounts.

## Maps and places

A *place* property holds where something is: an address, an optional name and its latitude and
longitude. In its cell you type an address or a place's name and pick one of the suggestions, or
paste coordinates (`41.04, 29.01`, also `geo:` links). The cell shows the name or address with a
link that opens the spot on OpenStreetMap. Filters take "contains", "does not contain", "is empty"
and "is not empty" on the address; sorting, CSV export and formulas read the address. MCP, the
REST API, the AI chat, agents, automations, imports and pastes may write an address (the server
looks it up), coordinates, or `{"lat": …, "lng": …, "address": …}`. Public forms don't ask for
places.

A *map* view puts each row with a place as a pin, fitted to the pins and following the view's
filters; *Pin color* in the layout settings colors pins by a select or status property. Clicking a
pin shows the row's title and shown properties, and opens the row. Rows without a place are listed
under the map. Published pages show map views as tables.

| Variable | Purpose |
| --- | --- |
| `GEOCODER_URL` | A Nominatim-compatible search service the server asks for addresses. Default `https://nominatim.openstreetmap.org`; empty turns address search off (places then take coordinates only). The default may not be on a private address; one you set may. Requests go from the server only, at most one a second for the whole server and 30 a minute per person, with a 5-second timeout, and answers are kept in memory for a day. |
| `MAP_TILE_URL` | The map's image tiles, with `{z}`, `{x}` and `{y}` (and optionally `{s}`) in it. Default `https://tile.openstreetmap.org/{z}/{x}/{y}.png`; empty turns map views off ("Maps are off on this server"). Browsers load the tiles directly. |
| `MAP_TILE_ATTRIBUTION` | The credit shown on the map, as plain text. Default `© OpenStreetMap contributors` (linked to its copyright page). Set it to what your tile provider asks for. |

The OpenStreetMap defaults are free services meant for light use: their usage policies
([search](https://operations.osmfoundation.org/policies/nominatim/),
[tiles](https://operations.osmfoundation.org/policies/tiles/)) allow a small team's occasional
lookups and map views, not bulk geocoding or heavy traffic. For more, run your own
[Nominatim](https://nominatim.org) and tile server or point the variables at a commercial
provider that offers the same interfaces. In the dark scheme the tiles are dimmed with a filter.

## Broken web links

Settings → Health lists web links in pages that stopped working: the server fetches the web
addresses of pages and URL properties in the background, about once a week each, from public
addresses only. Its requests say `Leafdesk link check (+APP_URL)`. To never fetch them, for a
server that shouldn't reach the internet on its own, set:

```bash
WEB_LINK_CHECKS=off
```

The same rule holds for every address someone in a workspace gives the server to fetch: saving a
web page, downloading a file a page shows from another site (anyone who may view the page, guests
too) and these link checks reach public addresses only, never the hosts in
`CONNECTOR_ALLOWED_HOSTS` (which are for connections and syncs an owner sets up). To let them
reach a host on your own network, an intranet wiki say, list it in `WEB_FETCH_ALLOWED_HOSTS`
(comma-separated, a host name or `host:port`; a bare name on ports 80, 443, 8080 and 8443 only).
Everyone in every workspace can then fetch it.

Health then says the links aren't checked. See [Workspace health](features.md) for what counts as
broken.

## Instance administrators

The first account created on a new server is its administrator, so whoever installs Leafdesk can
manage it right away. It stays one for good, verified address or not, even if it changes its
address; deleting it hands the role to nobody. Only an account that no other account predates
gets it: on a server that had accounts before this rule, nobody does, and of accounts signing up
at the same moment exactly one does. Its owner sees a note about it, and about closing sign-up,
after signing up.

Beyond that, whoever runs the server names the accounts that administer it. There is no role to
hand out in the database: the list below is the only other source, and an account in it counts
only once its email address is verified.

| Variable | Description |
|---|---|
| `ADMIN_EMAILS` | Comma-separated email addresses of the instance administrators, in any case, e.g. `ops@example.com, ada@example.com`. Empty by default: nobody is. |
| `WORKSPACE_CREATION` | Who may create workspaces: `everyone` (default) or `admins`. Any other value means `admins`. The personal workspace every new account gets at sign-up is still created. |

An address is verified by signing in once with GitHub or Google with it (when the provider
confirms the address), by resetting the password through the emailed link, or by whoever runs
the server:

```bash
pnpm auth:verify-email ops@example.com
# Docker: docker compose exec app tsx scripts/verify-email.ts ops@example.com
```

Administrators get **Server administration** in the workspace menu and in My account; for
everyone else `/admin` doesn't exist (404), and its actions do nothing. With
`WORKSPACE_CREATION=admins`, "New workspace" is hidden from everyone else and the server
refuses it. The page has:

- **Accounts:** every account with its email, whether the address is verified, how many
  workspaces it is in, when it was last active, and whether it uses two-step verification;
  search by name or email. The first 200 are listed; a search narrows them down.
- **Sign out everywhere** for one account, and **Sign out everyone** except the administrator's
  own browser. Both end the sessions and close their live collaboration connections.
- **Require a new password** for one account, or for everyone with a password (except the
  administrator, who changes theirs in My account). Their sessions end, and their next password
  sign-in gets no session. With SMTP, they get an email with a link to choose one (valid for 1
  hour; another is sent at most every 5 minutes); without it, the sign-in page asks for the new
  password right away, and for a two-step code when the account has it on. The old password
  can't be chosen again. Changing the password in My account clears the requirement too.
  Accounts without a password (GitHub, Google or single sign-on only) are not affected, and
  neither are other ways in: GitHub, Google, single sign-on and passkeys still sign them in.

Apps connected over MCP and REST API tokens use OAuth or personal access tokens, not sessions,
so signing people out doesn't disconnect them; the person revokes them under Connected apps, and
a workspace's owners can disconnect one from Settings → Security → *Apps that reach this workspace*.
Every administrator action is written to the server log (`[admin] …`).

## Deploy on Dokploy

Run the database as a Dokploy database service and the app as an Application, so Dokploy
handles database backups on its own. No compose file is involved.

1. Create a **Database → PostgreSQL** service with Docker image `postgres:18` and deploy it.
   Copy its **Internal Connection URL**.
2. Create an **Application** with this repository as its GitHub source and build type
   **Dockerfile**.
3. Under **Environment**, set `APP_URL` (the public origin, e.g. `https://notes.example.com`),
   `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and `DATABASE_URL` (the Internal Connection
   URL from step 1).
4. Under **Domains**, add your domain with container port `3000` and HTTPS.
5. Deploy. Migrations run when the container starts. Turn on auto deploy to redeploy on every
   push. For a health check, use path `/api/health` on port `3000` (see
   [Quick start](../README.md#quick-start-docker) for `/api/health/ready`).
