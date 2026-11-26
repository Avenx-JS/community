# Security Policy

Thank you for helping keep the **Avenx.js community platform** and its users
secure.

The platform stores accounts, private content such as modmail and appeals, and
moderation records. We take security seriously and appreciate responsible
disclosure of potential vulnerabilities. If you discover a security issue,
please report it privately so we can investigate and resolve it before public
disclosure.

---

## Supported Versions

The platform is deployed from `main`; there are no versioned releases.

| Version                     |   Supported    |
| --------------------------- | :------------: |
| `main` and the live service |       ✅       |
| Other branches and forks    |       ❌       |

---

## Reporting a Vulnerability

**Please do not create a public GitHub issue for security vulnerabilities.**

Instead, report vulnerabilities through:

- **GitHub Security Advisories:** use GitHub's
  [private vulnerability reporting](https://github.com/Avenx-JS/community/security/advisories/new)
  for this repository.

Please include as much information as possible:

- A clear description of the vulnerability and its impact
- Steps to reproduce the issue
- A proof of concept (if applicable)
- The affected route, component or commit
- Any suggested mitigation or fix

The more information you provide, the faster we can investigate.

---

## What to Expect

After receiving your report, we aim to:

- Acknowledge receipt within **48 hours**
- Begin investigating the issue promptly
- Keep you informed about our progress
- Release a fix as soon as reasonably possible
- Publicly credit you for the discovery (if you would like to be credited)

Response times may vary depending on the complexity and severity of the issue.

---

## Responsible Disclosure

We kindly ask that you:

- Give us reasonable time to investigate and fix the issue before public
  disclosure.
- Test only against your own local installation (see
  [CONTRIBUTING.md](CONTRIBUTING.md)), or against accounts you own on the live
  service.
- Never access, modify, or delete data that does not belong to you, and stop
  and report as soon as you reach another user's data.
- Do not run denial-of-service, spam, or automated mass-account tests against
  the live service.
- Do not use social engineering against users, moderators, or maintainers.

We value responsible security research and appreciate your cooperation.

---

## Scope

This policy covers this repository and the service deployed from it:

- The API (`apps/api`): authentication and sessions, authorization of users,
  community moderators and platform administrators, and data exposure
- The web client (`apps/web`)
- The database schema and migrations (`data/`)
- The deployment configuration (`deploy/`, `docker-compose.yml`)

Of particular interest are ways to:

- Act with another account's or a higher role's permissions
- Read private data (email addresses, modmail, appeals, reports, removed
  content) of another account
- Learn who moderated content or who reported it, which the platform never
  discloses
- Bypass a suspension, ban, community ban, block, or rate limit

Issues in third-party dependencies should be reported upstream; tell us too if
the platform is affected.

---

## Security Best Practices

When running your own installation:

- Start from `sample.env` and replace every example password and secret.
- Give the API's database user only the privileges it needs, and run
  migrations with separate credentials (see the
  [API README](apps/api/README.md#database-schema-and-migrations)).
- Never expose MySQL or Redis to the public network.
- Keep dependencies up to date.
- Run with `NODE_ENV=production`, which turns the Swagger UI off unless
  `SWAGGER_ENABLED=true` is set.

---

## Hall of Thanks

We appreciate security researchers who help improve the platform.

Contributors who responsibly disclose valid vulnerabilities may be acknowledged
in our security advisories, unless they prefer to remain anonymous.

Thank you for helping make the Avenx.js community safer for everyone.
