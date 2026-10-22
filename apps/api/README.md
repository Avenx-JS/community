<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Auth API

The API connects to MySQL using `MYSQL_HOST` (defaults to `127.0.0.1`),
`MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE`. For a new
installation, run `data/community.sql` from the repository root to create the
database and all tables. It is a fresh-install schema and is not a migration for
an existing database. Access and refresh tokens are opaque random credentials;
the database stores only their SHA-256 hashes.

`POST /auth/register` accepts `{ "username", "email", "password" }` and returns
HTTP `201`. `POST /auth/login` accepts `{ "identifier", "password" }`, where
`identifier` is a username or email, and returns HTTP `200`. Both return this
response shape:

```json
{
  "accessToken": "opaque-token",
  "tokenType": "Bearer",
  "expiresAt": "2026-10-15T08:15:00.000Z",
  "refreshToken": "opaque-refresh-token",
  "refreshTokenExpiresAt": "2026-11-14T08:00:00.000Z",
  "user": {
    "id": "user-id",
    "username": "sample_user",
    "email": "sample@example.com",
    "createdAt": "2026-10-15T08:00:00.000Z"
  }
}
```

Access tokens expire after 15 minutes. Send them as `Authorization: Bearer <token>`
to authenticated endpoints. `POST /auth/logout` requires this header and returns
HTTP `204`; it revokes that session and its refresh-token family. Registration
requires a 3-50
character username containing only letters, numbers, or underscores, a valid
email, and a 12-128 character password. Validation errors return `400`, duplicate
username/email returns `409`, and invalid login or missing, expired, or revoked
credentials return `401`.

Passwords are stored as Argon2id PHC hashes using version 19, 19 MiB memory,
two iterations, parallelism 1, and a 32-byte digest. These parameters meet the
OWASP Argon2id baseline. An isolated local five-hash benchmark on the
development runtime recorded 29-39 ms per hash (median 31 ms). Production
operators should benchmark under their actual CPU and concurrent-login load
before deployment, while retaining at least the documented memory and time
costs. Argon2id uses a fresh random salt per password through the maintained
`argon2` implementation.

Existing `scrypt$16384$8$1$...` hashes continue to verify. On the next
successful login, the API replaces the legacy hash with the current Argon2id
hash using a conditional update, so concurrent logins cannot overwrite a
changed password hash. This is an opportunistic migration; it does not require
password resets or a schema change. Accounts that never log in retain their
legacy hash until they do. Unsupported or malformed stored encodings are
treated as invalid credentials without exposing hash details to clients.
Passwords, salts, and encoded hashes are never returned by auth responses or
logged by this code. Hashing and verification remain server-side work; apply
the documented login rate limits and capacity-plan for the Argon2 memory cost
before scaling worker concurrency.

`POST /auth/refresh` accepts `{ "refreshToken": "<refreshToken>" }` and returns
HTTP `200` with the same response shape. Each refresh token can be used only
once; a successful refresh invalidates the previous access and refresh tokens.
Reusing a rotated refresh token revokes the entire session family. Refresh
tokens expire 30 days after session creation; rotation does not extend that
absolute lifetime. `POST /auth/logout` revokes the current session and its
refresh-token family. `POST /auth/logout-all` requires a valid access token and
revokes all sessions belonging to that user. Expired auth-session and
refresh-token records can be purged with periodic database maintenance.

Clients must protect both credentials, never place them in URLs or logs, and
avoid persisting refresh tokens in browser local storage. Browser clients should
keep credentials in memory until an appropriately protected cookie-based flow
is available; native clients should use platform secure storage.

### Authentication rate limits

Login, registration, and refresh requests use atomic fixed-window counters in
the shared MySQL `auth_rate_limits` table. Default limits are 20 login attempts
per IP and 10 per normalized account per 15 minutes; 5 registrations per IP
and 3 per normalized username/email per hour; and 30 refresh attempts per IP
and 10 per refresh token per hour. Exceeded limits return HTTP `429` with a
`Retry-After` header. Login failures remain generic, and no account lockout is
applied. The exported `AuthRateLimitService.enforceSignals()` method uses the
same shared counters and can be reused for future API route throttles.

Limits are configurable with `AUTH_LOGIN_IP_MAX`,
`AUTH_LOGIN_IP_WINDOW_SECONDS`, `AUTH_LOGIN_ACCOUNT_MAX`,
`AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS`, `AUTH_REGISTER_IP_MAX`,
`AUTH_REGISTER_IP_WINDOW_SECONDS`, `AUTH_REGISTER_ACCOUNT_MAX`,
`AUTH_REGISTER_ACCOUNT_WINDOW_SECONDS`, `AUTH_REFRESH_IP_MAX`,
`AUTH_REFRESH_IP_WINDOW_SECONDS`, `AUTH_REFRESH_TOKEN_MAX`, and
`AUTH_REFRESH_TOKEN_WINDOW_SECONDS`. Values must be integers from 1 to 86400.
The API does not trust proxy forwarding headers by default; `request.ip` uses
the direct socket address. Deployments behind a reverse proxy must configure
trusted proxy handling at the infrastructure/application boundary before
changing this behavior.

Rate-limit keys are HMAC-SHA-256 digests, not raw IPs, usernames, emails, or
tokens. Set a high-entropy `RATE_LIMIT_HASH_SECRET` shared by all API instances
in production; production startup fails if neither it nor `MYSQL_PASSWORD` is
configured. `MYSQL_PASSWORD` is used only as a fallback HMAC key when the
dedicated secret is absent. The local-development fallback is not suitable for
production. Expired counter rows may be removed periodically by deleting rows
whose `window_started_at` is older than the longest configured rate-limit
window.

## Public user profiles

`GET /users/:username` returns the public profile for the exact username with
HTTP `200`:

```json
{
  "id": "user-id",
  "username": "sample_user",
  "created_at": "2026-10-15T08:00:00.000Z"
}
```

The response includes only `id`, `username`, and `created_at`; it does not expose
the user's email, password, or password hash. If the username does not exist,
the endpoint returns HTTP `404`:

```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found"
}
```

## REST input and content safety

All request bodies and query DTOs pass through the global NestJS validation
pipe, which transforms declared fields, rejects unknown fields, and returns
`400` for invalid values. Route parameters for usernames, community names, and
resource IDs are separately constrained to their documented length and
allowlisted characters before a service or database query is called.
Pagination and search values have explicit bounds. User-controlled query
values are passed as MySQL parameters; the vote target table is selected only
from the fixed `post`/`comment` allowlist, never from arbitrary input.

Post titles, post bodies, community descriptions/rules, and comments are
plain-text data. The API does not interpret user text as HTML and returns it in
JSON as text; it is intentionally not HTML-escaped or stripped on input, so
clients must encode it at the output context. In the web client, render content
using Angular interpolation or DOM `textContent`; never use `[innerHTML]`,
`innerHTML`, or a bypass/trust-HTML API for user content. Any future rich-text
feature requires a separately reviewed, narrowly allowlisted sanitizer and
safe rendering pipeline.

Link and media posts accept only absolute HTTP(S) URLs with a hostname, no
control characters or backslashes, and no embedded username/password
credentials. This validation prevents unsafe schemes and confusing URL forms;
it does not fetch the URL server-side or assert that the destination is
trustworthy. JSON responses are `application/json`.

## API abuse controls and request bounds

All non-health REST requests use fixed-window counters persisted in the shared
MySQL `auth_rate_limits` table, with HMACed bucket identifiers. All requests
share a default limit of 300 per IP per minute. Reads have an additional limit
of 120 per IP per minute; non-read requests have an additional limit of 60 per
IP per minute and, when authenticated, 120 per account per minute. Creating a
post or comment is stricter: at most 10 per IP per 10 minutes, 5 per account
per 10 minutes, and one creation per account every 30 seconds. Account keys
come only from the authenticated bearer token, never from a request body or
forwarded identity header. Authentication endpoints retain their separate
limits documented above. Rejected requests return HTTP `429` and `Retry-After`.

Thresholds and fixed windows can be overridden using positive-integer
environment variables: `API_REQUEST_IP_MAX` and
`API_REQUEST_IP_WINDOW_SECONDS`; `API_READ_IP_MAX` and
`API_READ_IP_WINDOW_SECONDS`; `API_WRITE_IP_MAX` and
`API_WRITE_IP_WINDOW_SECONDS`; `API_WRITE_ACCOUNT_MAX` and
`API_WRITE_ACCOUNT_WINDOW_SECONDS`; `API_CONTENT_CREATE_IP_MAX` and
`API_CONTENT_CREATE_IP_WINDOW_SECONDS`; `API_CONTENT_CREATE_ACCOUNT_MAX` and
`API_CONTENT_CREATE_ACCOUNT_WINDOW_SECONDS`; and `API_CONTENT_COOLDOWN_MAX`
and `API_CONTENT_COOLDOWN_WINDOW_SECONDS`. Configure the same values and
`RATE_LIMIT_HASH_SECRET` on every API instance. The MySQL upsert counter is
atomic and shared across instances; process-local memory is not used for
limiting. Configure a trusted proxy hop count as described in the security
headers section to use client IPs behind a proxy; forwarded IP headers are
ignored by default.

Post and community collection pagination is bounded to `page=1..10000` and
`limit=1..100`; invalid values are rejected with HTTP `400`. A comment thread
returns at most 500 comments. If more exist, the bounded query fetches one
additional row and returns HTTP `413` rather than silently truncating a tree.
JSON request bodies are limited to 64 KiB by default. Set
`API_BODY_LIMIT_BYTES` to a value between 1,024 and 1,048,576 to adjust this
limit; requests exceeding it receive HTTP `413`.

Post and comment creation also has a server-enforced per-account cooldown, so
switching a client-supplied user ID cannot evade it. The unauthenticated
`GET /health` liveness endpoint is exempt from API rate limits and performs no
database work; protect it from excessive traffic at the network/load-balancer
layer. No other routes bypass the API limiter. Expired rows in
`auth_rate_limits` should be periodically purged by database maintenance after
their longest configured window has elapsed.

## Security headers and CORS

The API uses Helmet to set `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a restrictive CSP
(`default-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`). The CSP
is defense-in-depth for API responses; it does not sanitize data or protect a
separate client that renders API content. Clients must follow the plain-text
rendering policy above.

Set `CORS_ORIGINS` to a comma-separated list of exact origins, including scheme
and port when present, with no paths or wildcard values. In development, the
default is `http://localhost:4200,http://127.0.0.1:4200`; set the variable to
override it or to an empty value to allow no browser origins. In production the
default is empty, so configure the deployed web application's exact origin(s)
explicitly. Requests without an `Origin` header remain usable for server-side
clients; an unconfigured browser origin receives no CORS permission. CORS is
not authentication or CSRF protection and does not block non-browser clients.

Credentialed CORS is disabled because the API uses bearer tokens rather than
cross-origin cookies. Preflight permits the configured API methods and the
`Authorization` and `Content-Type` request headers, and is cached for ten
minutes. Browser clients should send bearer tokens explicitly; do not enable
credentialed CORS or wildcard origins without a separately reviewed cookie and
CSRF design.

HSTS is emitted only in production and only when the request is recognized as
HTTPS. For direct TLS termination, HTTPS is detected from the connection. If
TLS terminates at a reverse proxy, set `TRUST_PROXY_HOPS` to the exact number of
trusted proxy hops between the client and API; it defaults to `0`, and the
proxy must overwrite (not append untrusted client values to) forwarded protocol
headers. The API accepts only a bounded numeric hop count and does not trust
forwarded headers by default. HSTS is configured for one year with
`includeSubDomains`; enable it only when all covered hosts are HTTPS-capable.
The deployment must provide TLS at the trusted edge and restrict direct access
to the API so clients cannot impersonate that proxy.

## Communities

`GET /communities` returns a page of communities in a stable order
(`created_at` descending, then `id` descending). It accepts:

- `search`: optional, up to 100 characters; case-insensitive substring match
  against the community name and description.
- `page`: optional, one-based page number (default `1`).
- `limit`: optional page size from `1` to `100` (default `20`).

The response contains `items`, `page`, `limit`, and the matching `total`. An
empty result is returned as HTTP `200` with an empty `items` array.

`POST /communities` requires a bearer token and accepts a `name` (1-50
characters containing only letters, numbers, underscores, or hyphens), plus
optional `description` and `rules` (up to 16,383 characters each, keeping values
within MySQL's `TEXT` limit with UTF-8 storage). The creator
is taken from the authenticated user, never from the request
body. A duplicate name returns `409`; invalid input returns `400`.
`GET /communities/:name` retrieves a community by its exact name and returns
`404` if it does not exist.

All community endpoints return the same community DTO:

```json
{
  "id": "community-id",
  "creator_id": "user-id",
  "name": "sample",
  "description": null,
  "rules": null,
  "created_at": "2026-10-22T08:00:00.000Z"
}
```

`POST /communities/:name/subscribe` subscribes the authenticated user to the
community. `DELETE /communities/:name/subscribe` removes that user's
subscription. Both require a bearer token, resolve the community by its exact
name, and return HTTP `204` with no response body on success. Repeating either
operation is safe: subscribing twice leaves one subscription, and unsubscribing
when no subscription exists still returns `204`. An unknown community returns
`404`.

### Community roles and moderation

Community membership is represented by `community_subscriptions`. The
community creator (`communities.creator_id`) is the sole administrator and is
an implicit member. A moderator must first be a subscribed member; moderator
assignments are stored separately in `community_moderators`, scoped by both
community and user. Moderator authorization is always checked against the
specific community. There is no global administrator role.

Only the community creator can appoint or remove moderators using
`POST /communities/:name/moderators` and
`DELETE /communities/:name/moderators`, each with
`{ "username": "member_name" }` and a bearer token. These operations return
`204`, unknown communities/users return `404`, and non-creator attempts return
`403`. The actor identity comes only from the validated bearer token; request
data cannot set a role or actor ID. The creator cannot delegate moderator
management, and moderators cannot appoint other moderators.

Post and comment authors retain their existing ability to delete their own
content. A moderator or creator can additionally delete content only within
their own community. Other users receive `403`; missing content returns `404`.
No edit, lock, ban, or other moderator-only operations are exposed by this API
yet; future such routes must enforce the same server-side, community-scoped
checks.

## Posts

`GET /posts` is public and returns `{ "items", "page", "limit", "total",
"sort" }`. It accepts optional `community_id`, one-based `page` (default `1`),
`limit` from `1` to `100` (default `20`), and `sort=new` (the only supported
sort order). Posts are ordered by `created_at` descending, then `id` descending
to keep pagination stable. An empty page is returned with HTTP `200`.

`POST /posts` requires a bearer token and accepts `title` (1-300 characters),
`type` (`text`, `link`, or `media`), non-empty `content` (up to 16,383
characters), and an existing `community_id`. For `text`, content is the post
body. For `link` and `media`, content must be an HTTP or HTTPS URL. The author
is always taken from the authenticated user; body-supplied `author_id` is
rejected. Successful creation returns HTTP `201` and the post DTO.

`GET /posts/:id` is public and returns the post DTO, or `404` for an unknown ID.
`DELETE /posts/:id` requires a bearer token and allows the authenticated author
to delete their post, or a moderator/creator of that post's community to
moderate it. It returns HTTP `204` with no body; a user without permission
returns `403`, and an unknown post returns `404`. The database cascades deletion
to the post's comments.

Post responses use this DTO:

```json
{
  "id": "post-id",
  "title": "A post",
  "content": "Post body",
  "type": "text",
  "author_id": "user-id",
  "community_id": "community-id",
  "created_at": "2026-10-22T08:00:00.000Z"
}
```

## Comments

`GET /posts/:postId/comments` is public and returns
`{ "post_id", "comments" }`. Comments are nested recursively through `replies`;
each comment contains its `id`, `post_id`, `author_id`, `parent_id`, `content`,
`created_at`, and `replies`. Roots and sibling replies use chronological order
(`created_at` ascending, then `id` ascending), making the thread order stable.
An unknown post returns `404`.

`POST /posts/:postId/comments` requires a bearer token and accepts non-empty
`content` (1-16,383 characters) and an optional `parent_id`. The author is
always taken from the authenticated user. The post must exist, and a supplied
parent must belong to that same post; an unknown or cross-post parent returns
`404`. A successful creation returns HTTP `201` and the created comment DTO
with an empty `replies` array.

`DELETE /comments/:id` requires authentication and allows the authenticated
author to delete their comment, or a moderator/creator of the comment's
community to moderate it. Success returns HTTP `204` with no body; a user
without permission returns `403`, and an unknown comment returns `404`.
Deleting a comment also deletes all descendant replies because the comments
table uses `ON DELETE CASCADE` for `parent_id`.

## Votes

`POST /votes` requires a bearer token and accepts `target_type` (`post` or
`comment`), `target_id`, and `value` (`1` or `-1`). The voter ID always comes
from the authenticated user. Invalid input returns `400`; an unknown target
returns `404`.

The endpoint creates the user's vote or updates its value when a vote already
exists for that user and target. The database's `unique_user_target` constraint
enforces one vote per user and target, including concurrent requests. The
target is locked during the transaction so the response includes the stored
vote and the score recalculated from all votes for that target.

Success returns HTTP `201`:

```json
{
  "id": "vote-id",
  "user_id": "user-id",
  "target_type": "post",
  "target_id": "post-id",
  "value": 1,
  "created_at": "2026-10-22T08:00:00.000Z",
  "score": 3
}
```

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
