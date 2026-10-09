# Security policy

Leafdesk holds people's notes, files and the tokens of the apps they connect, so we take reports
of security problems seriously and are grateful for them. Please report them privately, as
described below, and not in a public issue, pull request or discussion.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting: on the repository's
[Security tab](https://github.com/esmworks/leafdesk/security), choose **Report a vulnerability**
(or open [the form](https://github.com/esmworks/leafdesk/security/advisories/new) directly). Only
the maintainers see the report, and we can discuss it, work on a fix and publish an advisory in
the same place.

A report we can act on quickly says:

- **What is affected:** the version (a release such as `0.4.0`, or a commit of `main`) and how
  Leafdesk runs (the Docker image, Docker Compose, built from source), with any setting that
  matters (single sign-on, `DISABLE_SIGNUP`, file storage on S3, a reverse proxy…).
- **What someone can do with it:** for example read a page they weren't given access to, act as
  another person, or run code on the server, and what they need first (an account, membership in
  the workspace, a guest invitation, nothing at all).
- **How to reproduce it:** the steps or requests, ideally a short proof of concept against a
  fresh instance.
- **Anything else useful:** logs, a suggested fix, and whether and how you would like to be
  credited.

One report per problem helps us track each of them. Write in English or Turkish.

## What happens next

| | Within |
| --- | --- |
| We confirm we have the report | 3 business days |
| We tell you whether we consider it a vulnerability, and how severe | 10 business days |
| We tell you how the fix is going | every 2 weeks until it is released |

We fix confirmed vulnerabilities in `main` and ship them in a release, with a GitHub security
advisory (and a CVE where it applies) and an entry in [CHANGELOG.md](CHANGELOG.md) that says
what to do to upgrade. We credit the reporter there, unless they prefer not to be named. Please
keep the details to yourself until the advisory is out; if a fix takes longer than 90 days, we
agree a date with you.

## Supported versions

Leafdesk is before 1.0 and releases often, so fixes go into the latest release only. Run the
newest release (or pin `LEAFDESK_VERSION` and move it forward when a release says it fixes a
vulnerability; see [Quick start](README.md#quick-start-docker)).

| Version | Security fixes |
| --- | --- |
| Latest release | Yes |
| `main` | Yes, first |
| Older releases | No: upgrade to the latest |

## Scope

In scope is everything in this repository and the image built from it
(`ghcr.io/esmworks/leafdesk`):

- the web app and its server, including sign-in, two-step verification, passkeys, single sign-on
  and SCIM,
- page, database and workspace permissions, guests and sharing,
- published pages and sites, public forms and share links,
- the REST API, the MCP server and its OAuth, webhooks, automations, agents and connections,
- collaborative editing, file uploads and downloads, import and export,
- the service worker and offline copies kept in the browser,
- `docker-compose.yml` and the defaults in `.env.example`.

Not in scope:

- Vulnerabilities in a dependency that Leafdesk's use doesn't expose. Report those to the
  dependency; if Leafdesk is affected in a way that matters, tell us too. Dependencies are
  checked against published advisories every week (`.github/workflows/dependencies.yml`).
- A server set up against the documentation, such as one with the example secret from
  `.env.example`, without HTTPS, or with its database reachable from the internet. (Where
  Leafdesk can catch such a setting itself, it should; if it doesn't, that is worth a report.)
- Something that needs access to the server, an administrator's account or a device that is
  already compromised.
- Denial of service by sheer volume of requests, social engineering, and spam.
- Missing headers or settings without a way to exploit their absence.

## Testing

Test against your own instance (the [Quick start](README.md#quick-start-docker) gets one running
in a few minutes) and your own accounts. Don't test against instances other people run, and
don't access, change or keep data that isn't yours. If you come across someone else's data,
stop, and tell us in the report. Research done in good faith along these lines is welcome, and we
won't take action against it.

## Running Leafdesk safely

- Set `BETTER_AUTH_SECRET` to a random value (`openssl rand -base64 32`); in production the
  server refuses to start with the example value or a short one. Consider a separate
  `LEAFDESK_ENCRYPTION_KEY` for the tokens of connected apps (see `.env.example`).
- Serve it over HTTPS and set `APP_URL` to the public origin; set `TRUSTED_PROXIES` to the number
  of reverse proxies in front of it.
- Close sign-up with `DISABLE_SIGNUP=true` once your accounts exist, and choose who may create
  workspaces with `WORKSPACE_CREATION` (see [Instance administrators](README.md#instance-administrators)).
- Workspace owners decide in Settings → Security what may leave the workspace, who may join, and
  whether two-step verification is required (see
  [Workspace security switches](README.md#workspace-security-switches)).
- Watch the repository's releases, and upgrade when one fixes a vulnerability.
