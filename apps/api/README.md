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
database and all tables. The file is the maintained full-install snapshot; it
is not itself a migration for an existing database. Access and refresh tokens
are opaque random credentials; the database stores only their SHA-256 hashes.

### Database schema and migrations

After configuring the `MYSQL_*` variables, apply pending schema migrations from
`apps/api` with:

```sh
npm run migrate
```

For a fresh installation, run `data/community.sql` first, then run the command
above. Existing installations created from that snapshot can run the migration
command directly. The runner creates `schema_migrations` and records
`000_baseline` for the existing schema before applying later migrations.
`data/community.sql` remains the maintained full-install snapshot and must be
updated in the same change as each migration, keeping new and upgraded
installations aligned.

Migration files live in `data/migrations/` and use the
`NNN_snake_case_description.sql` naming rule. They run in ascending numeric
order. Once released, a migration is append-only: correct mistakes with a new
migration rather than changing an existing file. Since MySQL DDL is not
transactional, each migration should contain one logical change and its header
must state whether it is safe to re-run after partial application.

The migration command needs DDL privileges such as `CREATE`, `ALTER`, and
`INDEX`. Prefer separate credentials: grant these privileges to the operator
running migrations, not the API runtime database user. Migration credentials
are read from the environment and are never printed; do not place passwords in
the command line or migration files.

### Platform roles

`users.role` is an `ENUM` with the values `user`, `moderator`, and `admin`,
defaulting to `user`. An enum matches the existing schema style (`posts.type`
and `votes.target_type`); adding a future role requires a schema migration.

- `user` is the default and grants the capabilities available today, including
  community creator and moderator powers. Those powers remain independent of
  the platform role.
- `admin` grants platform-wide administration for the `/admin` surface planned
  by the backlog.
- `moderator` currently grants nothing beyond `user`. Whether it will grant
  platform-wide report triage without role changes or permanent bans remains
  an open product-policy decision.

No API endpoint can assign or change a platform role. An operator provisions
the first administrator directly in the database by executing the prepared
statement `UPDATE users SET role = 'admin' WHERE username = ?` with the target
username bound as its parameter. Do not expose role on public profiles or auth
responses; it is read from the database for server-side authorization only.

### Administration API conventions

Administrative endpoints use the `/admin` namespace and explicitly apply
`@UseGuards(AuthGuard, AdminGuard)` in that order. Missing, malformed, invalid,
or expired bearer credentials return `401`; a valid account without the role
required by the route returns `403`. The guard defaults to `admin`.
`@RequiresRole(...)` is the single extension point for a future platform
moderator policy; until then, moderator accounts are denied.

Within an authorized admin request, unknown resources and resources that do not
belong to the requested parent return `404`. Errors use the existing
`SafeApiExceptionFilter` response shape; unexpected failures return a generic
`500` and log only the method, route template, and status. Admin collections
follow `{ items, page, limit, total }`, with `page` bounded to 1–10000 and
`limit` to 1–100. Use stable ordering with a tiebreaker such as `id` alongside
`created_at DESC`. Offset pagination matches existing API collections.

Admin routes remain subject to the global API rate limits; do not exempt the
namespace. If expected dashboard usage exceeds the existing read bucket,
introduce an explicit documented rate-limit override rather than bypassing
limits.

### Administrative action audit log

`admin_actions` records moderation and other administrative decisions. It is
separate from operational logs and is append-only in application code: there
are no update or delete operations for audit entries. `AuditLogService.record`
can use a caller's existing `PoolConnection`, so a moderation action and its
audit row commit or roll back together. If a caller has no transaction, it may
use the standalone overload, which acquires and releases a connection. A
failure to insert the audit record must fail the enclosing action as well.

The actor ID comes from the caller's validated bearer-token identity; the
service looks up the actor username from the database and snapshots it into
`actor_username`. The snapshot remains readable after the actor account is
deleted and `actor_id` is set to `NULL`. If usernames are ever reusable, that
snapshot identifies the historical username, not necessarily the current
account using it. `target_id` is polymorphic and deliberately has no foreign
key, so readers must handle deleted targets without assuming they exist.

Only the following metadata keys may be recorded:

| Action                  | Allowed metadata                            |
| ----------------------- | ------------------------------------------- |
| `report_status_changed` | `from_status`, `to_status`, `resolution`    |
| `user_suspended`        | `restriction_id`, `expires_at`, `report_id` |
| `user_banned`           | `restriction_id`, `report_id`               |
| `restriction_lifted`    | `restriction_id`, `restriction_type`        |
| `user_role_changed`     | `from_role`, `to_role`                      |

The service builds metadata from this allowlist and drops extra runtime keys.
Passwords and hashes, tokens, session identifiers, email addresses, and free
text such as `reason`, `lift_reason`, or `resolution_note` are never copied to
audit metadata. Audit entries themselves are sensitive and may only be exposed
through future admin-authorized read routes. Do not log the contents of an
audit entry to application logs. Database grants or a trigger can additionally
enforce append-only behavior at deployment time.

**Retention policy:** retain audit actions indefinitely by default; do not
automatically purge them. A database operator may purge records only
case-by-case after documented privacy or legal approval. Operational log
retention guidance (normally no more than 30 days) does not apply to this
moderation-decision history.

The metadata allowlist above is also the disclosure boundary for
`GET /admin/audit-log`, which returns metadata exactly as stored. Loosening the
allowlist exposes the new keys through that route; change both together.

### Admin audit log API

`GET /admin/audit-log` is the read-only view of `admin_actions`. It uses
`@UseGuards(AuthGuard, AdminGuard)` with an explicit `@RequiresRole('admin')`:
`401` without a valid token, and `403` for members and platform moderators.

**Moderator access is an open decision.** The trail records enforcement
actions against identifiable accounts, along with the administrators who took
them. That is oversight material, not triage material, so the default is
administrators only. Granting moderators access means changing the one
`@RequiresRole` decorator on `AdminAuditLogController`.

**The trail is append-only.** There is no `PATCH`, `PUT`, or `DELETE` route on
`/admin/audit-log` or any sub-path; those verbs return `404` from the router.
An administrator who could edit the record of their own actions would make
the trail worthless.

| Parameter        | Rules                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| `actor_username` | 3–50 of `[A-Za-z0-9_]`; exact match on the stored username snapshot        |
| `action`         | one of the `admin_actions.action` values (shared `ADMIN_ACTIONS` constant) |
| `target_type`    | `user`, `report`, or `restriction`                                         |
| `target_id`      | 1–36 of `[A-Za-z0-9_-]`; requires `target_type`                            |
| `from`, `to`     | ISO 8601; half-open UTC interval `from <= created_at < to`                 |
| `page`           | integer 1–10000, default 1                                                 |
| `limit`          | integer 1–100, default 20                                                  |
| `sort`           | `new` (default, `created_at DESC, id DESC`) or `oldest` (`ASC, ASC`)       |

Unknown parameters, invalid values, and `target_id` without `target_type`
return `400`. `target_id` needs `target_type` because ids are not unique
across target kinds, and because the target index starts with `target_type`.
`actor_username` matches the snapshot column rather than joining `users`, so
entries by a deleted administrator remain findable. The `id` tiebreaker gives
a total order, because a single transaction can write several entries within
the same second. Every filter applies to both the items and `total`.

Example response:

```json
{
  "items": [
    {
      "id": "action-id",
      "actor_username": "admin",
      "actor_id": "admin-user-id",
      "action": "user_suspended",
      "target_type": "user",
      "target_id": "target-user-id",
      "metadata": {
        "restriction_id": "restriction-id",
        "expires_at": "2026-10-31T10:00:00.000Z",
        "report_id": "report-id"
      },
      "created_at": "2026-10-28T10:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "filters": {
    "actor_username": null,
    "action": null,
    "target_type": null,
    "target_id": null,
    "from": null,
    "to": null,
    "sort": "new"
  }
}
```

`actor_id` is `null` once the acting account has been deleted, while
`actor_username` keeps the snapshot. Clients can use this to tell a current
administrator from a departed one. `metadata` is a JSON object or `null`.

**No target resolution.** `target_id` has no foreign key, and the route
returns the raw id without joining a username or report title. For details,
follow up with `GET /admin/users/:id` or `GET /admin/reports/:id`; deleted
targets return `404` there. Entries whose target no longer exists are still
listed.

Index use per filter (MySQL picks one index; other conditions filter its
rows):

| Filter present                       | Index                                                 |
| ------------------------------------ | ----------------------------------------------------- |
| `target_type` (+ `target_id`)        | `idx_admin_actions_target`                            |
| `actor_username`                     | `idx_admin_actions_actor_username` (migration `006`)  |
| `action`                             | `idx_admin_actions_action`                            |
| none, or only `from`/`to`            | `idx_admin_actions_created_at`                        |

The four indexes from Draft 11 did not cover `actor_username`, because
`idx_admin_actions_actor` is on `actor_id`. Migration
`006_add_admin_actions_actor_username_index` adds `(actor_username,
created_at)`. Deep offsets are bounded by the page cap. A full-history export
would be a separate streaming tool, not a change to this endpoint.

Reads of the audit log are not themselves audited, matching the other admin
read routes. Auditing audit reads is a defensible policy for larger
organisations; it is deliberately not implemented here.

### Admin user analytics

`GET /admin/analytics/users` returns aggregate account metrics. It uses
`@UseGuards(AuthGuard, AdminGuard)`: `401` without a valid token, `403` for
members and moderators. Platform statistics are not public, and
`suspended_users` is a moderation signal. The route is read-only and writes no
audit entry.

| Parameter     | Rules                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| `from`, `to`  | strict ISO 8601, UTC when no zone is given; half-open `[from, to)`       |
| `granularity` | `day` (default) or `week`; affects only the series buckets               |

Without `from`/`to`, the range is the 30 days ending now, truncated to the
second. If only one bound is given, the other defaults to 30 days from it (or
to now). The request returns `400` when `from >= to`, when the range exceeds 366
days, when a date is malformed, or when an unknown parameter is present. The
resolved `from`/`to` and `generated_at` are echoed, so a dashboard can label
exactly what it shows.

**Point-in-time and range metrics are mixed deliberately.** Point-in-time
metrics describe the moment of the request and ignore the range. A
`suspended_users` value does **not** mean "suspended during this period".
`meta.scopes` labels each metric in the response.

| Field                  | Definition                                                                 | Scope         | Time column                    | Source                                                                       |
| ---------------------- | -------------------------------------------------------------------------- | ------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `total_users`          | All accounts that exist now                                                | point in time | —                              | `users`; the sum of `users_by_role` (`role` is `NOT NULL`)                   |
| `new_users`            | Accounts created in `[from, to)`                                           | range         | `users.created_at`             | `users`; the sum of the daily series rows                                    |
| `series.new_users`     | `new_users` per UTC day or ISO week, zero-filled                           | range         | `users.created_at`             | `users`, grouped by `FLOOR(UNIX_TIMESTAMP(created_at) / 86400)`              |
| `active_users`         | Accounts whose most recent authenticated request is in `[from, to)`        | range         | `users.last_seen_at`           | `users`; `NULL` `last_seen_at` never counts                                  |
| `users_by_role`        | Accounts per platform role, with `0` for unused roles                      | point in time | —                              | `users GROUP BY role`                                                        |
| `suspended_users`      | Distinct accounts with an active `suspension` now                          | point in time | —                              | `user_restrictions`, `ACTIVE_USER_RESTRICTION_PREDICATE`, `COUNT(DISTINCT user_id)` |
| `banned_users`         | Distinct accounts with an active `ban` now                                 | point in time | —                              | as above, `type = 'ban'`                                                     |
| `restrictions_applied` | Restrictions created in `[from, to)`, by type, including lifted ones       | range         | `user_restrictions.created_at` | `user_restrictions GROUP BY type`                                            |

Details:

- The restriction counts use the same predicate as enforcement and
  `COUNT(DISTINCT user_id)`. An account with two active rows is counted once,
  and expired or lifted rows drop out without any job running.
- Series buckets are UTC days (`2026-09-23`) or ISO weeks (`2026-W39`). The
  ISO week-year can differ from the calendar year: 2027-01-03 is in
  `2026-W53`. Every bucket that overlaps the range is present, with `0` where
  nothing happened, because MySQL emits no row for an empty day. Edge buckets
  can be partial, but the series always sums to `new_users`. SQL groups by UTC
  day, and weeks are rolled up from days in application code
  (`analytics-range.ts`), independent of MySQL week modes and the session time
  zone.

**Active-user caveats.** `last_seen_at` records only each account's *most
recent* request, at a resolution of `USER_ACTIVITY_WRITE_INTERVAL_SECONDS`, and
it cannot be backfilled. Therefore:

- `meta.active_users_since` is the earliest non-null `last_seen_at`. Because
  each account's value moves forward when it is seen again, this marks
  collection start conservatively late.
- `meta.active_users_resolution_seconds` is the configured write interval.
- `meta.active_users_is_floor` is `true` when the count is a lower bound,
  not a count. That happens when no activity has been recorded, when `from`
  precedes `active_users_since`, or when `to` is further in the past than one
  resolution interval. In the last case, accounts active in the window and
  again afterwards have moved out of it. Windows ending now are exact.

The response is **aggregate-only**: no username, account id, email, or
individual timestamp appears in it. Row-level lists such as "recent
registrations" belong in the user directory, not here. Low counts on a small
deployment can still narrow things down. That is acceptable only because the
audience is administrators who can read the rows directly; do not expose these
metrics on a non-admin surface. No statement touches `email`, `password_hash`,
`auth_sessions`, `auth_refresh_tokens`, or `auth_rate_limits`.

**Cost.** Each request runs a fixed five statements in parallel, whatever the
range length. Together with the 366-day cap and the global read rate limits,
that bounds the work per request. Migration `007_add_analytics_indexes` adds
the indexes these statements need:

| Statement                        | Expected index                                                |
| -------------------------------- | ------------------------------------------------------------- |
| registration count and series    | `idx_users_created_at` (range, covering)                      |
| active users                     | `idx_users_last_seen_at` (range; `MIN` resolved from index)   |
| role grouping                    | `idx_users_role`                                              |
| active restrictions              | `idx_user_restrictions_unlifted` (`lifted_at IS NULL` ref)    |
| restrictions applied             | `idx_user_restrictions_created_at` (range)                    |

Verify these with `EXPLAIN` against the docker-compose MySQL 8.0 instance and
record the plans in the pull request; the mocked test suites cannot show a
plan. No cache is used. If dashboards later poll aggressively, a short TTL
cache is a separate change.

### Admin moderation analytics

`GET /admin/analytics/moderation` returns aggregate report and sanction
metrics. It uses `@UseGuards(AuthGuard, AdminGuard)` (`401`/`403` as above),
writes nothing, and audits nothing. Query parameters, defaults, and `400`
rules are identical to `/admin/analytics/users`; both routes share
`AnalyticsQueryDto` and `resolveAnalyticsRange`.

**Submitted and decided reports are different populations.** A report
submitted last month and decided today counts in `reports_reviewed` and not in
`reports_submitted`. The two figures come from different columns and are not
comparable as a ratio. Every metric names its time column in
`meta.time_basis`. Point-in-time figures sit under their own
`point_in_time` key, so they cannot be read as range metrics by accident.

| Field                                          | Definition                                                                         | Scope         | Time column                    | Source                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- | ------------------------------ | --------------------------------------------------------- |
| `totals.reports_submitted`                     | Reports created in `[from, to)`                                                    | range         | `user_reports.created_at`      | `user_reports`                                            |
| `series.reports_submitted`                     | The same per UTC day or ISO week, zero-filled, summing to the total                | range         | `user_reports.created_at`      | `user_reports`, grouped by UTC day                        |
| `reports_by_reason`                            | Reports created in range per reason, with `0` for every unused reason              | range         | `user_reports.created_at`      | `user_reports`                                            |
| `totals.reports_reviewed`                      | Reports **decided** (`resolved` or `rejected`) in `[from, to)`                     | range         | `user_reports.reviewed_at`     | `user_reports`                                            |
| `resolutions_by_type`                          | Decided-in-range reports per resolution, plus `rejected`; `0` for unused values    | range         | `user_reports.reviewed_at`     | `user_reports`                                            |
| `time_to_review_seconds`                       | `{ average, maximum, count }` of `reviewed_at - created_at` for decided-in-range reports; `null`s when `count` is 0 | range | `user_reports.reviewed_at` | `user_reports` |
| `restrictions_applied`                         | Restrictions created in range per type                                             | range         | `user_restrictions.created_at` | `user_restrictions`                                       |
| `totals.restrictions_lifted`                   | Restrictions explicitly lifted in range; expiry alone does not count               | range         | `user_restrictions.lifted_at`  | `user_restrictions`                                       |
| `point_in_time.backlog_by_status`              | Reports in each status now, with `0` for every unused status                       | point in time | —                              | `user_reports GROUP BY status`                            |
| `point_in_time.oldest_open_report_age_seconds` | Age of the oldest `open` or `under_review` report now; `null` when there is none   | point in time | —                              | `user_reports`                                            |

Details:

- `reviewed_at` is also written when a report moves to `under_review`, so a
  triaged-but-undecided report has a `reviewed_at`. The reviewed metrics
  therefore count only terminal statuses, for which `reviewed_at` is the
  decision time. Reports with `reviewed_at IS NULL` never count. Reports
  currently under review appear only in the backlog.
- `rejected` is its own bucket in `resolutions_by_type`, because rejected
  reports carry no resolution. `time_to_review_seconds.count` always equals
  `totals.reports_reviewed`, so a reader can judge how much the average is
  worth. The average is rounded to whole seconds.
- Durations and ages use `UNIX_TIMESTAMP()` differences rather than
  `TIMESTAMPDIFF(…, UTC_TIMESTAMP())`. The latter mixes a session-zone value
  with a UTC value, and it shifts across DST changes.
- **Median is deliberately omitted.** MySQL 8.0 has no `MEDIAN` aggregate,
  and computing one needs a window function that sorts the matching set,
  instead of a streaming aggregate. Average, maximum, and count ship first.
  Add a percentile as a separate, measured change if the average proves
  misleading.

**Aggregate-only.** The response contains enum counts only: no report id,
reporter or reported account, username, or free text (`description`,
`resolution_note`, `reason`, `lift_reason`). There is deliberately no
"most reported accounts", "top reporters", or other ranking. Those are
row-level data about identifiable people, and a leaderboard invites acting on
report volume rather than on reviewed evidence. Per-account report counts
belong on the user directory and report detail, next to their context. The
low-count caveat from user analytics applies here too: acceptable for
administrators, not for any other surface. No statement touches `email`,
`password_hash`, or any `auth_*` table.

**Cost.** Each request runs a fixed six statements in parallel, whatever the
range length. Migration `008_add_report_analytics_indexes` adds covering
indexes for both report populations:

| Statement                              | Expected index                                                            |
| -------------------------------------- | ------------------------------------------------------------------------- |
| submitted per day and reason           | `idx_user_reports_created_reason (created_at, reason)`, covering          |
| decided outcomes and time to review    | `idx_user_reports_reviewed (reviewed_at, status, resolution, created_at)`, covering |
| backlog by status                      | `idx_user_reports_status_created`                                         |
| oldest open report                     | `idx_user_reports_status_created` (`status IN` range, `MIN(created_at)`)  |
| restrictions applied                   | `idx_user_restrictions_created_at` (migration `007`)                      |
| restrictions lifted                    | `idx_user_restrictions_unlifted (lifted_at, expires_at)` (migration `007`) |

Verify the plans with `EXPLAIN` against the docker-compose MySQL 8.0 instance
and record them in the pull request.

### Admin user directory

`GET /admin/users` and `GET /admin/users/:id` require a bearer token and the
`admin` platform role. Both routes are read-only. The list returns
`{ items, page, limit, total, filters }`; supported query parameters are:

| Parameter     | Accepted values                                                                               |
| ------------- | --------------------------------------------------------------------------------------------- |
| `search`      | Case-insensitive username substring, up to 100 characters; `%`, `_`, and `=` match literally  |
| `role`        | `user`, `moderator`, or `admin`                                                               |
| `status`      | `active`, `suspended`, or `banned`, derived from active restriction rows                      |
| `from` / `to` | ISO 8601 timestamps; UTC half-open range over `created_at` (`from` inclusive, `to` exclusive) |
| `page`        | Integer 1–10000; defaults to `1`                                                              |
| `limit`       | Integer 1–100; defaults to `20`                                                               |
| `sort`        | `new` (default), `oldest`, or `username`; ties are ordered by account ID                      |

The list item contains the account ID, username, platform role, registration
time, `status`, `restriction_expires_at`, and `open_reports_against`.
`GET /admin/users/:id` adds `last_seen_at`, activity counts
(`posts_count`, `comments_count`, `votes_count`, `communities_created`,
`subscriptions_count`, and `moderated_communities_count`), `reports_against`
counts by queue status, `reports_filed_count`, and `restrictions` counts for
active rows and total history. Unknown IDs return `404`; malformed IDs return
`400`.

Account status is derived from `user_restrictions`, not stored on `users`. The
shared active-row predicate is
`lifted_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())`.
An expired suspension therefore becomes inactive without a background job.
When direct database writes have left multiple active restrictions on one
account, the directory treats an active ban as dominant over a suspension;
the restrictions service must prevent creating that state through the API.
Detail responses include the number of active restrictions and total history
count, but not restriction reasons or a paginated history. `last_seen_at` is the latest recorded authenticated API activity time; accounts
not yet seen since collection began have `null`.

Restriction storage choices: deleting a restricted account cascades its
restriction rows, while deleting the applying/lifting administrator or linked
report preserves the restriction and nulls that reference. Applying and lifting
are otherwise recorded in the restriction row rather than deleting history.
The database permits more than one active row because expiry depends on the
current time and cannot be represented by a normal unique constraint. The
restriction-writing service must enforce one active restriction in a
transaction; read paths use `EXISTS`-compatible/aggregated logic that tolerates
multiple rows.

Restrictions are authoritative and status is derived rather than duplicated in
a `users.status` column. This avoids two sources of truth and avoids an expiry
job whose delay or failure could leave a suspension in force after its expiry.
The trade-off is a restriction lookup on reads, supported by
`idx_user_restrictions_active`. The active predicate is exported as
`ACTIVE_USER_RESTRICTION_PREDICATE` for shared query use. `CHECK` constraints
require MySQL 8.0.16 or later; confirm the deployed minor version because the
compose file's `mysql:8.0` tag alone does not guarantee that minimum.

Restriction policy decisions not established by the project remain
**undecided**:

1. Whether permanent bans are permitted at launch.
2. Whether a ban should remove existing account content. Restricting rather
   than deleting preserves posts, comments, and communities; account deletion
   currently cascades its communities and their content.
3. Whether a ban should release the username or email for reuse. Both remain
   reserved while the account row exists.
4. Whether an appeal process is needed and requires states beyond `lifted_at`.
5. The maximum allowed suspension duration.

The restriction table stores reasons as plain text; reasons are not interpreted
as HTML. It stores no email, password hash, token, or session data.
Restrictions are created and lifted through the routes in
[Account restrictions](#account-restrictions-suspensions-and-bans) and
enforced on authentication, refresh, and every guarded route.

Email is intentionally excluded from both admin responses. This preserves the
data-classification guarantee that email is not returned by profile, auth,
content, or list responses. Neither route returns password hashes, credentials,
tokens, session identifiers, or auth-rate-limit keys. The public
`GET /users/:username` contract is unchanged and still returns only
`{ "username": "..." }`.

Example list response:

```json
{
  "items": [
    {
      "id": "user-id",
      "username": "sample_user",
      "role": "user",
      "created_at": "2026-10-25T10:00:00.000Z",
      "status": "active",
      "restriction_expires_at": null,
      "open_reports_against": 2
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "filters": {
    "search": null,
    "role": null,
    "status": null,
    "from": null,
    "to": null,
    "sort": "new"
  }
}
```

Example detail response:

```json
{
  "id": "user-id",
  "username": "sample_user",
  "role": "user",
  "created_at": "2026-10-25T10:00:00.000Z",
  "status": "active",
  "restriction_expires_at": null,
  "open_reports_against": 2,
  "last_seen_at": null,
  "posts_count": 3,
  "comments_count": 4,
  "votes_count": 5,
  "communities_created": 1,
  "subscriptions_count": 2,
  "moderated_communities_count": 1,
  "reports_against": {
    "open": 1,
    "under_review": 1,
    "resolved": 0,
    "rejected": 0
  },
  "reports_filed_count": 2,
  "restrictions": {
    "active": 1,
    "history_count": 2
  }
}
```

### Admin report queue

Both report-reading routes require a bearer token and the `admin` platform
role. They are read-only; neither endpoint changes report status or acts on an
account.

`GET /admin/reports` lists reports in the `{ items, page, limit, total, filters }`
envelope. Optional query parameters:

| Parameter           | Accepted values                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `status`            | `open`, `under_review`, `resolved`, `rejected`                                               |
| `reason`            | `spam`, `harassment`, `hate_speech`, `sexual_content`, `self_harm`, `impersonation`, `other` |
| `reported_username` | Exact username, 3–50 letters, digits, or underscores                                         |
| `reporter_username` | Exact username, 3–50 letters, digits, or underscores                                         |
| `from` / `to`       | ISO 8601 timestamps; UTC half-open range `created_at >= from AND created_at < to`            |
| `page`              | Integer 1–10000; defaults to `1`                                                             |
| `limit`             | Integer 1–100; defaults to `20`                                                              |
| `sort`              | `new` (default) or `oldest`; ties use the report ID                                          |

When both dates are supplied, `from` is inclusive and `to` is exclusive. A
report exactly at `to` is not included. This half-open UTC convention should
also be used for report metrics and other date-range analytics.

List items include report and queue fields, `has_context`, timestamps, and the
reporter/reported usernames. A deleted reporter is shown as `null`; the
reported username is present because reports against deleted accounts are
cascaded away. Free-text descriptions are returned only by the detail route.
An empty page returns `200` with an empty `items` array.

```json
{
  "items": [
    {
      "id": "report-id",
      "reporter_username": null,
      "reported_username": "target_user",
      "reason": "spam",
      "status": "open",
      "resolution": null,
      "has_context": true,
      "created_at": "2026-10-25T10:00:00.000Z",
      "reviewed_at": null
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "filters": {
    "status": null,
    "reason": null,
    "reported_username": null,
    "reporter_username": null,
    "from": null,
    "to": null,
    "sort": "new"
  }
}
```

`GET /admin/reports/:id` returns one report's detail, including description,
resolution note, reviewer username, context, and triage aggregates:
`open_reports_against_user`, `total_reports_against_user`, and
`prior_resolutions_against_user` grouped by resolution. `context` is `null`
when no context was filed; a deleted referenced post/comment returns
`exists: false` and null detail fields. Deleted reporter and reviewer usernames
are also `null`. Unknown report IDs return `404`; malformed IDs return `400`.

```json
{
  "id": "report-id",
  "reporter_username": null,
  "reported_username": "target_user",
  "reason": "spam",
  "status": "open",
  "resolution": null,
  "has_context": true,
  "created_at": "2026-10-25T10:00:00.000Z",
  "reviewed_at": null,
  "description": "Repeated spam posts",
  "resolution_note": null,
  "reviewed_by_username": null,
  "context": {
    "type": "post",
    "id": "post-id",
    "exists": true,
    "title": "Post title",
    "content_excerpt": "Post content excerpt",
    "author_username": "target_user"
  },
  "open_reports_against_user": 2,
  "total_reports_against_user": 4,
  "prior_resolutions_against_user": [
    { "resolution": "content_removed", "total": 2 }
  ]
}
```

`PATCH /admin/reports/:id` requires a platform administrator and accepts:

```json
{
  "status": "resolved",
  "resolution": "no_action",
  "resolution_note": "Reviewed by the moderation team."
}
```

`status` is required and must be `under_review`, `resolved`, or `rejected`.
`resolution` is required only for `resolved` and must be one of `no_action`,
`content_removed`, `user_warned`, `user_suspended`, or `user_banned`.
`resolution_note` is optional plain text up to 2,000 characters and is trimmed.
Fields such as `reviewed_by` are rejected; attribution is derived from the
validated administrator token.

Allowed state transitions are:

| Current status | `under_review` | `resolved` | `rejected` |
| -------------- | -------------- | ---------- | ---------- |
| `open`         | allowed        | allowed    | allowed    |
| `under_review` | `409`          | allowed    | allowed    |
| `resolved`     | `409`          | `409`      | `409`      |
| `rejected`     | `409`          | `409`      | `409`      |

Resolved and rejected reports are terminal. Repeating the current status also
returns `409`, preserving the original reviewer and timestamp. `rejected`
means the report was not a violation and has no resolution outcome; `resolved`
with `resolution: "no_action"` means it was reviewed as a possible violation
but no action was taken. Resolving a report records a decision only: even
`resolution: "user_suspended"`, `"user_banned"`, or `"content_removed"` does
not itself suspend or ban an account or remove content. Those actions require
their separate moderation endpoints. The report update and its
`report_status_changed` audit entry are committed in one transaction; audit
metadata includes only `from_status`, `to_status`, and `resolution`, never the
free-text note.

Administrators cannot review reports where they are the reporter or the
reported user; those requests return `403`. Reopening reports and changing
terminal decisions are not supported; appeals or a reopening workflow require
a separate policy and state-machine change.

### Account restrictions (suspensions and bans)

Deleting, suspending, and banning an account are three different operations.
These routes implement only temporary suspension and permanent ban, each as an
explicitly typed operation; there is no account deletion here, and no single
call performs more than one of them. All three routes use
`@UseGuards(AuthGuard, AdminGuard)`: `401` without a valid token, `403` for
non-administrators. Both path ids pass `SafeRouteParamPipe('id')`, so a
malformed id returns `400`.

| Method | Path                                                  | Success |
| ------ | ----------------------------------------------------- | ------- |
| `POST` | `/admin/users/:id/restrictions`                       | `201`   |
| `POST` | `/admin/users/:id/restrictions/:restrictionId/lift`   | `200`   |
| `GET`  | `/admin/users/:id/restrictions?page=1&limit=20`       | `200`   |

Apply body:

```json
{
  "type": "suspension",
  "reason": "Repeated spam after warning",
  "duration_hours": 72,
  "report_id": "optional-report-id"
}
```

`type` is `suspension` or `ban`. `reason` is required trimmed plain text,
1–2000 characters. `duration_hours` is an integer from 1 to 8760, required for
a suspension and rejected for a ban (`400` either way). `report_id` is
optional and must reference an existing report (`404` otherwise); it links the
restriction to the report whose outcome Draft 07 records, without that
endpoint applying anything itself. Unknown properties, including
`created_by`, `expires_at`, and `lifted_at`, return `400`. The acting
administrator is always the token's user id.

**Duration, not timestamp.** The server computes
`expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL duration_hours HOUR)`, so the
deadline comes from the database clock like every other timestamp. Accepting
a client-supplied `expires_at` would invite timezone and clock-skew mistakes,
and would allow a deadline in the past. The 8760-hour ceiling is a proposal;
the maximum suspension length is still an open policy question (see above).

Apply rules:

- Unknown user: `404`.
- An account with an active restriction: `409`. Restrictions do not stack.
- **Escalation is explicit.** To turn a suspension into a ban, lift the
  suspension, then apply the ban. That takes two calls, writes two audit
  entries, and leaves an unambiguous history. There is no silent replace.
- Restricting your own account: `403`.
- Restricting an account with `role = 'admin'`: `403`. This conservative
  default stays until a policy defines who may restrict administrators and
  with what oversight. Moderators and members can be restricted.

The apply runs in one transaction. It locks the target `users` row
(`FOR UPDATE`) and then re-checks the active-restriction predicate. Concurrent
applies for one account are therefore serialised: exactly one succeeds and
the rest get `409`. Locking the row matters because the re-check usually
matches nothing, and gap locks alone would let two inserts deadlock. The insert
and its `user_suspended`/`user_banned` audit entry commit together, and an
audit failure rolls back the restriction.

**Session revocation happens after the commit, and its failure is
tolerated.** After the transaction commits, the service calls
`AuthService.logoutAll(userId)`, which deletes the account's sessions and
revokes its refresh tokens. That call is a latency optimisation, not the
enforcement mechanism. `AuthGuard`, login, and refresh check the restriction
row on every request. So if revocation fails, the restriction stays in place
and the request still succeeds: the next request with an old access token is
refused as restricted, and refresh is refused too. Moving revocation into the
transaction would make it a single point of failure for the whole feature.

Lift body: `{ "lift_reason": "Appeal accepted" }`, with the same text rules as
`reason`. Lifting is `POST .../lift` rather than `DELETE`: the row is kept and
annotated with `lifted_at`, `lifted_by`, and `lift_reason`, and a `DELETE`
with a required body would be semantically wrong and awkward for clients. The
update is conditional on `lifted_at IS NULL`. A restriction that is already
lifted returns `409`. An unknown restriction id, or one that belongs to a
different user than the path names, returns `404`. A lift writes a
`restriction_lifted` audit entry in the same transaction.

An **expired suspension can still be lifted**. It changes nothing for
enforcement, but it records that an administrator closed the case, and
moderators do not have to compare clock times before acting.

**Lifting does not restore sessions.** Tokens revoked when the restriction
was applied are gone for good. After a lift, the user signs in again.

Restriction response, used by apply, lift, and history items:

```json
{
  "id": "restriction-id",
  "type": "suspension",
  "reason": "Repeated spam after warning",
  "created_by_username": "admin",
  "created_at": "2026-10-28T10:00:00.000Z",
  "expires_at": "2026-10-31T10:00:00.000Z",
  "lifted_at": null,
  "lifted_by_username": null,
  "lift_reason": null,
  "report_id": null,
  "active": true
}
```

History returns `{ items, page, limit, total }`, with `page` 1–10000,
`limit` 1–100 (default 20), ordered `created_at DESC, id DESC`. `active` is
computed with `ACTIVE_USER_RESTRICTION_PREDICATE`. `created_by_username` and
`lifted_by_username` are `null` when the acting administrator's account has
been deleted. An unknown user returns `404`; an account without restrictions
returns an empty `items` array.

`reason`, `lift_reason`, and the acting administrators appear only in these
admin responses. A restricted user sees only `type` and, for a suspension,
`expires_at`. No response here contains an email address, password hash,
token, or session value. The global API write rate limits apply.

### User reports

The `user_reports` table stores account reports and moderation lifecycle data.
`reason` is one of `spam`, `harassment`, `hate_speech`, `sexual_content`,
`self_harm`, `impersonation`, or `other`. `status` describes queue state
(`open`, `under_review`, `resolved`, or `rejected`) and defaults to `open`;
`resolution` separately records an outcome (`no_action`, `content_removed`,
`user_warned`, `user_suspended`, or `user_banned`) and is nullable. A resolved
report with `no_action` is distinct from a rejected report.

Reports use deliberate account-deletion behavior: deleting a reporter or
reviewer preserves the report and sets the corresponding reference to `NULL`;
deleting the reported account deletes its reports (`ON DELETE CASCADE`). This
chooses full erasure of reports about a deleted account over retaining
identifiable moderation history. `context_id` has no foreign key because it can
refer to either a post or comment; that content may have been deleted when a
report is reviewed, and consumers must handle missing context as `null`.

The schema enforces that reporter and reported user differ and that context
type and ID are either both present or both absent with `CHECK` constraints.
MySQL enforces `CHECK` constraints starting in 8.0.16; the deployment must use
at least that minor version, and report creation must also validate these rules
in the service layer. Queue, reported-user, reporter history, reporter abuse
checks, and reviewer lookups have dedicated indexes.

Duplicate prevention belongs in the report-creation service transaction, not
in a unique key: a unique constraint would block later reports after resolution,
and MySQL treats `NULL` values as distinct, leaving user-level reports
unconstrained. A generated open-status column would have the same `NULL`
context-key issue unless context were normalized to a sentinel, which is not
used here.

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
    "username": "sample_user"
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

`GET /users/:username` returns only the public username for the exact account
with HTTP `200`:

```json
{
  "username": "sample_user"
}
```

The profile endpoint does not expose the account ID or creation timestamp, and
never exposes email, password, or password hash. If the username does not
exist, the endpoint returns HTTP `404`:

```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found"
}
```

## Data classification, errors, and logging

- **Public:** username and user-authored post/comment content. Post and comment
  DTOs expose their public content identifiers and author IDs for attribution;
  those IDs are not credentials.
- **Private account data:** email is accepted for registration and login but is
  not returned by profile, auth, content, or list responses. The signed-in
  auth-response user object contains only that account's ID and username; user
  creation time and `last_seen_at` are not exposed by the profile or auth
  response. `last_seen_at` is private behavioral data and is only available
  through admin-authorized account detail and analytics.
- **Never returned or logged:** plaintext passwords, password hashes, salts,
  bearer/refresh tokens, token hashes, and session identifiers. Encoded
  password hashes remain database-only. Access and refresh credentials appear
  only in the HTTPS authentication response to the requesting client and must
  be stored securely by that client.

Login failures use the same `401` response for unknown accounts, incorrect
passwords, and malformed stored hashes. Duplicate-registration errors use the
same generic `409` response for username and email conflicts; field-specific
details are not returned. Unexpected server errors return a generic `500`.
The global exception filter logs only the HTTP method, route template, and
status for server errors; it does not log exception text, stack traces, actual
path values, query strings, request bodies, or headers.

The API does not install an HTTP access/request logger, and source verification
confirms there are no `console` calls or application logger calls elsewhere
that serialize request data. Deployments must apply the same redaction at
reverse proxies, load balancers, APM, and log collectors: do not capture request
bodies or `Authorization`/`Cookie` headers, and omit query strings. Restrict
operational log access to authorized operations/security staff, audit access,
and retain logs for no longer than 30 days unless an incident or legal hold
requires a documented extension. HMAC rate-limit bucket keys are pseudonymous
operational identifiers rather than anonymous data and should be purged after
the longest configured counter window.

### Authenticated activity and active-user definition

> An account is **active in a window** if `last_seen_at` falls within that window, where `last_seen_at` is the time of its most recent authenticated API request, recorded at a resolution of `USER_ACTIVITY_WRITE_INTERVAL_SECONDS` (default 5 minutes).

`USER_ACTIVITY_WRITE_INTERVAL_SECONDS` accepts an integer from 1 through 86400. The conditional timestamp update runs only after access-token
validation; telemetry errors are deliberately ignored and cannot turn an
invalid token into a successful authentication. Writes are limited to at most
one effective update per user per configured interval. Public and unauthenticated
requests are not attributed, so this measures authenticated API use, not
signed-out browsing or use satisfied entirely by client-side caching.

`last_seen_at` is not backfillable: it is `NULL` for every account until its
first authenticated request after deployment. Active-user history before
collection began is unknown, not zero. Analytics should expose collection
start; the earliest non-null `last_seen_at` is the simplest available signal
for when the series became meaningful. The five-minute default also limits
precision: activity within a single interval is not distinguishable.

A daily `user_activity (user_id, activity_date, request_count)` rollup could
support long-term trends and retention cohorts while allowing old daily rows to
be purged. It is intentionally deferred because it adds a second table, an
upsert per interval, and a separate backfill/retention design. Revisit that
model when long-window trends are needed.

## REST input and content safety

All request bodies and query DTOs pass through the global NestJS validation
pipe, which transforms declared fields, rejects unknown fields, and returns
`400` for invalid values. Route parameters for usernames, community names, and
resource IDs are separately constrained to their documented length and
allowlisted characters before a service or database query is called; numeric
route parameters such as a rule version are bounded integers.
Pagination and search values have explicit bounds. User-controlled query
values are passed as MySQL parameters; the vote target table is selected only
from the fixed `post`/`comment` allowlist, never from arbitrary input.

Post titles, post bodies, community descriptions, community rule titles and
bodies, and comments are plain-text data. The API does not interpret user text
as HTML and returns it in JSON as text; it is intentionally not HTML-escaped or
stripped on input, so clients must encode it at the output context. In the web client, render content
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

## Reports

`POST /reports` requires a bearer token and creates a report about another
account. The reporter is always derived from the token. The JSON body accepts:

- `username`: target username (3–50 letters, digits, or underscores).
- `reason`: one of `spam`, `harassment`, `hate_speech`, `sexual_content`,
  `self_harm`, `impersonation`, or `other`.
- `description`: optional plain text, trimmed and limited to 2,000 characters.
- `context_type` and `context_id`: optional pair. The type is `post` or
  `comment`; the identifier is 1–36 letters, digits, underscores, or hyphens.
  The referenced content must exist and have been authored by the reported
  account.

Unknown accounts or missing context return `404`. Reporting yourself or
pointing to content by another account returns `400`. An active duplicate
report by the same reporter for the same account and context returns `409`;
after the earlier report is resolved or rejected, another report may be filed.
No action is taken against the reported account by submitting a report.
Reports against suspended or banned accounts are accepted.

Success returns `201` with only the report receipt:

```json
{
  "id": "report-id",
  "reported_username": "target_user",
  "reason": "spam",
  "status": "open",
  "created_at": "2026-10-25T10:00:00.000Z"
}
```

The response does not disclose the target's internal ID, email, report history,
or moderation outcome. `reporter_id`, status, resolution fields, and all other
undeclared body fields are rejected with `400`. Descriptions are stored as
plain text and must be encoded by clients when rendered.

Report creation has additional fixed-window limits of 20 per IP per hour and
10 per authenticated account per hour, in addition to the generic write
limits. Override them with positive-integer `API_REPORT_CREATE_IP_MAX`,
`API_REPORT_CREATE_IP_WINDOW_SECONDS`, `API_REPORT_CREATE_ACCOUNT_MAX`, and
`API_REPORT_CREATE_ACCOUNT_WINDOW_SECONDS`. Account counters use only the
validated bearer-token user ID. Exceeding a limit returns `429` and
`Retry-After`.

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

## API documentation (OpenAPI)

The API publishes an OpenAPI 3 document generated from the controllers and
DTOs with `@nestjs/swagger`:

- `GET /docs` serves Swagger UI. Use **Authorize** with an access token from
  `POST /auth/login` to try authenticated routes; the token is not persisted
  in the browser.
- `GET /docs/openapi.json` and `GET /docs/openapi.yaml` serve the document
  itself, for client generation or import into API tools.

The documentation is served by default outside production and is off when
`NODE_ENV=production`. `SWAGGER_ENABLED=true` or `false` overrides the default
in either direction; any other value fails startup. The document describes
every route, including administrative ones, so enable it in production only
deliberately. The docs routes are not rate limited, and their pages get their
own Content Security Policy (same-origin scripts and requests, inline styles),
while every API route keeps the policy described under "Security headers and
CORS".

How the document is built, and what a new route needs:

- **Request schemas** come from the DTO classes through the `@nestjs/swagger`
  compiler plugin (`nest-cli.json`). It turns class-validator rules into schema
  constraints (`@IsIn` to `enum`, `@Length` to `minLength`/`maxLength`,
  `@Matches` to `pattern`, `@Min`/`@Max`) and JSDoc comments on properties into
  descriptions, so rules are not duplicated. Jest applies the same plugin with
  the same options through `swagger-plugin.transformer.js`. The plugin misreads
  properties with initializers (`page = 1`) as required and does not map
  `@IsInt`, so those properties carry an explicit `@ApiPropertyOptional`.
  Cross-field rules, which the plugin cannot see, are described in JSDoc.
- **Response schemas** are classes in each module's `*.responses.ts`. Each one
  `implements` the service's response interface, so the compiler reports a
  missing or mistyped field. Enums and count maps are built from the same
  constants the services use.
- **Each route** declares `@ApiTags`, `@ApiOperation`, its success response,
  `@ApiAuthenticated()` when it uses `AuthGuard`, its route parameters with
  `@ApiRouteParam` (the patterns enforced by `SafeRouteParamPipe`), and its
  error statuses with `@ApiErrorResponses`. All errors use the
  `ErrorResponse` schema; a suspended or banned account receives the
  `RestrictedAccountResponse` 403 body instead. The 429 response is declared
  once, globally.

`src/common/swagger.spec.ts` builds the document from the full application
and fails when a route is undocumented, lacks a summary, tag or typed success
response, when bearer security does not match the route's `AuthGuard`, or
when a schema property degrades to an untyped object.

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
characters containing only letters, numbers, underscores, or hyphens), plus an
optional `description` (up to 16,383 characters, keeping values within MySQL's
`TEXT` limit with UTF-8 storage). The creator is taken from the authenticated
user, never from the request body. A duplicate name returns `409`; invalid
input returns `400`. `GET /communities/:name` retrieves a community by its
exact name and returns `404` if it does not exist.

All community endpoints return the same community DTO:

```json
{
  "id": "community-id",
  "creator_id": "user-id",
  "name": "sample",
  "description": null,
  "created_at": "2026-10-22T08:00:00.000Z"
}
```

**Breaking change: rules are no longer part of a community.** `POST
/communities` no longer accepts `rules`; sending it, even as `null` or an
empty string, returns `400` and creates nothing. No community response
(`GET /communities`, `GET /communities/:name`, `POST /communities`) contains a
`rules` key any more. Creating a community with rules is now two calls:
`POST /communities`, then `PUT /communities/:name/rules`. Read rules from
`GET /communities/:name/rules` (see [Community rules](#community-rules)). A
community created without publishing rules has no rule document and requires
no acceptance.

The legacy free-text field was removed rather than kept in sync because two
copies of the rules disagreed: the field kept serving text after a publish
replaced it, and text set only at creation never became a document, so it was
invisible to acceptance. Two alternatives were rejected:

- Having `POST /communities` publish a version 1 document from the field would
  add a second publishing path with different validation (one free-text blob
  versus 1-50 validated items), which is how the two sources of truth arose.
  If creation should ever publish rules, it must call the rules service and
  its validation, never insert directly.
- Keeping `rules` as a deprecated response field built from the current
  document would add a join or subquery to every row of the hottest community
  read, for a field nothing should use.

`POST /communities/:name/subscribe` subscribes the authenticated user to the
community. `DELETE /communities/:name/subscribe` removes that user's
subscription. Both require a bearer token, resolve the community by its exact
name, and return HTTP `204` with no response body on success. Repeating either
operation is safe: subscribing twice leaves one subscription, and unsubscribing
when no subscription exists still returns `204`. An unknown community returns
`404`.

`GET /subscriptions` requires a bearer token and returns a page of the
authenticated user's own subscriptions. The user is taken only from the
validated token; the route accepts no user parameter, so one account cannot
read another's subscriptions. It accepts `page` (`1-10000`, default `1`) and
`limit` (`1-100`, default `20`); out-of-range, non-integer, or unknown query
parameters return `400`. Results are ordered by subscription time descending,
then community ID descending, so paging is stable. The response uses the
standard collection envelope, and an account with no subscriptions receives
`200` with an empty `items` array:

```json
{
  "items": [
    {
      "community": {
        "id": "community-id",
        "name": "sample",
        "description": null
      },
      "subscribed_at": "2026-10-22T08:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

Each item carries only the community fields a list view needs; `creator_id`
belongs to the community detail response.

`GET /communities/:name/subscription` requires a bearer token and reports
whether the authenticated user is subscribed to that community:

```json
{ "subscribed": false, "subscribed_at": null }
```

When subscribed, `subscribed` is `true` and `subscribed_at` is the subscription
time. A user who is not subscribed receives `200` with `subscribed: false`, not
`404`: "am I subscribed?" has a valid negative answer, and the route uses `404`
only for an unknown community, so the two cases stay distinguishable. Invalid
community names return `400`.

Both routes report the stored subscription row. The community creator is an
implicit member (see below) but is reported as subscribed only if they have
also subscribed. The routes report membership only and say nothing about
notification delivery. Like every other route except `GET /health`, both count
against the API read rate limits.

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
management, and moderators cannot appoint other moderators. Publishing
community rules is likewise creator-only (see [Rules API](#rules-api)).

Post and comment authors retain their existing ability to delete their own
content. A moderator or creator can additionally delete content only within
their own community. Other users receive `403`; missing content returns `404`.
No edit, lock, ban, or other moderator-only operations are exposed by this API
yet; future such routes must enforce the same server-side, community-scoped
checks.

### Community notification preferences

Membership defines the delivery scope for community-activity notifications,
and a preference row is a mute switch inside that scope:

- Only members of a community (rows in `community_subscriptions`) receive its
  community-activity notifications. Joining opts a member in by default.
- `community_notification_preferences` holds at most one row per user and
  community (`new_posts`, `updated_at`). A missing row means `new_posts` is
  enabled, so joining writes no preference and existing members needed no
  backfill (migration `011_create_community_notification_preferences`).
- Leaving a community stops its notifications regardless of any preference,
  because delivery is driven by membership. Unsubscribing does not touch the
  preference table; a leftover row has no effect, and it restores the member's
  mute if they rejoin.
- A preference never grants delivery to a non-member. Following a community
  without joining it is deliberately not supported; it would be a separate
  capability with its own questions about rule acceptance and visibility.
- Deleting the user or the community deletes their preference rows.

There is a single `new_posts` flag rather than a per-type matrix. New posts are
the only notification frequent enough to need an off switch; replies and
moderation outcomes follow from the user's own content or account. Another flag
can be added later with a migration.

`GET /communities/:name/notification-preferences` and
`PUT /communities/:name/notification-preferences` require a bearer token and
always act on the authenticated user's own preference. Both return:

```json
{ "new_posts": true, "subscribed": false }
```

`new_posts` is the effective value, resolved from the stored row or the
default, so clients never need to know that a missing row means enabled.
`subscribed` is included because nothing is delivered without membership:
`new_posts: true` with `subscribed: false` delivers nothing. A user with no
stored preference receives `200` with the defaults, not `404`.

`PUT` takes the complete settings object, `{ "new_posts": false }`, where
`new_posts` is a required boolean. It replaces the stored value with an upsert,
so repeating it is safe and leaves one row. A missing or non-boolean
`new_posts`, or any other property, returns `400` and writes nothing. A
non-member may store a preference: it is kept but has no effect until they
join. Both routes return `404` for an unknown community and `400` for an
invalid community name.

Notification producers must select community-activity recipients with this
query (`COMMUNITY_NEW_POST_RECIPIENTS_SQL` in
`src/communities/community-notification-recipients.ts`):

```sql
SELECT s.user_id
FROM community_subscriptions s
LEFT JOIN community_notification_preferences p
       ON p.user_id = s.user_id AND p.community_id = s.community_id
WHERE s.community_id = ? AND COALESCE(p.new_posts, TRUE) = TRUE
```

It selects members without a preference row and members with `new_posts`
enabled, and excludes muted members and every non-member. Producers may add
conditions, such as excluding the post's author, but must not drop these.
`idx_community_notification_preferences_community` serves the join from the
community side. A unit test keeps this text identical to the constant; with
`MYSQL_INTEGRATION_TEST=true` and `MYSQL_*` credentials that may create a
scratch database, the same test also checks the query against MySQL.

### Community rules

Community rules are stored as immutable, versioned documents (migration
`009_create_community_rule_documents`) and are read and published through the
routes described under [Rules API](#rules-api).

- `community_rule_documents` holds one row per published version of a
  community's rules: `version`, `content_hash`, `published_at`, and
  `published_by`. `version` is a per-community counter starting at `1`, so a
  community's history reads v1, v2, v3; the unique key on
  `(community_id, version)` makes two concurrent publishes of the same version
  impossible. The current document is the one with the highest `version` for
  that community; there is deliberately no "current document" column on
  `communities` that could disagree with these rows.
- `community_rules` holds the ordered rule items of one document: `position`
  (unique within the document), `title` (up to 200 characters), and an
  optional `body`.

Published documents and their rules are never updated. Changing a community's
rules inserts a new document with the next `version`, so a future acceptance
record that points at a document always resolves to exactly the rules that
were accepted. Deleting a community deletes its documents and rules; deleting
the publishing account keeps the document and sets `published_by` to `NULL`.

`content_hash` is the lowercase hex SHA-256 of a canonical serialisation of
the rule items. A publish whose hash equals the current document's hash leaves
the effective rules unchanged, so it reuses that version instead of forcing
every member to accept again. Only rule items are hashed: community name,
description, and other metadata are outside the document, and editing them
never requires reacceptance. The canonical form, implemented by
`hashCommunityRules()` in `src/communities/community-rules-hash.ts`, is:

- items sorted by ascending `position`, each serialised as
  `position LF len(title) ":" title LF len(body) ":" body`, where `len` is the
  UTF-8 byte length in decimal and a `NULL` body is the empty string;
- items joined by a single LF, the result UTF-8 encoded and hashed.

The byte-length prefixes keep the form unambiguous, so a body containing line
breaks cannot hash the same as several separate rules. Values are hashed
exactly as stored, without trimming; code that publishes rules must normalise
input before both storing and hashing it. The migration backfill computes the
same form in SQL with `SHA2()`, and a unit test pins both to a fixture digest
produced by MySQL.

The migration backfills one `version = 1` document for every community whose
legacy `communities.rules` contains a non-whitespace character. The document is
dated `communities.created_at`, attributed to the community creator, and has
one rule at position `1` titled `Community rules` whose body is the legacy text
verbatim. Communities with `NULL`, empty, or whitespace-only rules get no
document and have no rules to accept. Migration `013` repeats this for
communities created after `009`, and `014` then drops the legacy column (see
[Retiring the legacy `communities.rules` column](#retiring-the-legacy-communitiesrules-column)).

#### Rules API

`CommunityRulesController` and `CommunityRulesService` own these routes. The
three reads are public, like `GET /communities/:name`: rules are published
community policy, and people deciding whether to join must be able to read
them without an account. Every route resolves the community by its exact name,
returns `400` for an invalid name and `404` for an unknown community, and
counts against the global API rate limits (reads, or writes for `PUT`); none is
exempt and there is no dedicated bucket, because publishing is rare.

`GET /communities/:name/rules` returns the current document (highest
`version`) with its items in ascending `position`:

```json
{
  "version": 2,
  "published_at": "2026-10-22T08:00:00.000Z",
  "items": [
    { "position": 1, "title": "Be civil", "body": "No personal attacks." }
  ]
}
```

A community that has never published rules returns `200` with
`{ "version": null, "published_at": null, "items": [] }`, not `404`. Having no
rules is a valid state, the one in which no acceptance is required, and `404`
stays reserved for an unknown community.

`GET /communities/:name/rules/versions` returns the version history in the
standard collection envelope, newest version first. It accepts `page`
(`1-10000`, default `1`) and `limit` (`1-100`, default `20`); out-of-range,
non-integer, or unknown query parameters return `400`.

```json
{
  "items": [
    {
      "version": 2,
      "published_at": "2026-10-22T08:00:00.000Z",
      "published_by_username": "creator_name",
      "rule_count": 1
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 2
}
```

`published_by_username` is `null` when the publishing account has been
deleted.

`GET /communities/:name/rules/versions/:version` returns one version in the
same shape as the current-rules route. `version` must be an integer from `1`
to `4294967295`; anything else returns `400`, and a version the community never
published returns `404`. Published versions never change, so this is how an
acceptance record's version is resolved back to the text that was accepted.

`PUT /communities/:name/rules` requires a bearer token, publishes the complete
document, and returns `200` with the resulting document in the same shape:

```json
{
  "items": [
    { "title": "Be civil", "body": "No personal attacks." },
    { "title": "No spam" }
  ]
}
```

- `items` is required and holds `1-50` rules in display order.
- `title` is required, trimmed, and 1-200 characters after trimming.
- `body` is optional, trimmed, and up to 4,000 characters; a missing, `null`,
  or whitespace-only body is stored as `NULL`.
- Both reject control characters other than tab, line feed, and carriage
  return.
- `position` is not accepted: each item's position is its one-based index in
  `items`, so a request cannot create gaps, duplicates, or a stored order that
  disagrees with the submitted one. Sending `position`, or any other unknown
  property, returns `400`.

Invalid bodies return `400` and write nothing. A document near every bound can
exceed the default 64 KiB JSON body limit and receive `413`; raise
`API_BODY_LIMIT_BYTES` if a community needs that much text.

Publishing replaces the whole document rather than offering per-rule
`POST`/`PATCH`/`DELETE`. Documents are immutable and versioned, so editing one
rule in place would need a partial-version concept; a whole-document replace
keeps every version a complete, self-contained document, and "what changed
between v1 and v2" is answered by comparing two of them.

The service normalises the items, derives positions, and computes
`content_hash` over exactly what it stores. If that equals the current
document's hash, the request returns `200` with the current version and
inserts nothing, so a cosmetic re-save never forces members to accept again.
Reordering the same items changes the hash and publishes a new version,
because order is part of the published document. Otherwise one transaction
locks the community row (`SELECT ... FOR UPDATE`), re-reads the current
document, inserts the next `version` with `published_by` taken from the token
and `published_at` from the database clock, and inserts the items. Any failure
rolls back the whole publish, so a version without rules cannot exist, and
earlier versions are never touched. If two publishes still race to the same
version, the unique `(community_id, version)` key rejects the second, which
returns `409` and writes nothing; the client may retry.

**Authorization.** Only the community creator (`communities.creator_id`) may
publish; everyone else, including community moderators, receives `403`, and
an unauthenticated request receives `401`. An unknown community returns `404`
before authorization is evaluated, matching the moderator-management routes.
Excluding moderators is the conservative default: rules are the document every
member must agree to, and widening who may rewrite them is a product decision.
The check lives only in `canPublishCommunityRules()` in
`src/communities/community-rules.service.ts`; permitting moderators later means
changing that function and its test. Platform administrators have no bypass;
the `/admin` surface does not edit community rules.

No rules response contains an email address, password hash, token, or session
value.

#### Rule acceptances

`community_rule_acceptances` (migration `012_create_community_rule_acceptances`)
records which rule document each user accepted and when. Users read and record
their own acceptance through the routes in
[Rule acceptance API](#rule-acceptance-api).

- The key is `(user_id, document_id)`: one row per user per version. Accepting
  the same version again is a no-op that keeps the original `accepted_at`, and
  accepting a newer version adds a row, so every version a user ever accepted
  stays on record. A per-community key would overwrite the previous acceptance
  and destroy that history.
- A mutable `accepted` flag on the membership row was rejected because it
  would keep reading `true` after the rules change, pointing at text the user
  never saw. The version must be part of the record.
- `community_id` is denormalised from the document so that "communities this
  user accepted rules for" is a single-table, index-served query. It is always
  copied from the document in the same statement that resolves the document,
  never taken from a request. `accepted_at` is always set by the database
  clock.
- Acceptance cannot be withdrawn; there is no revocation column. A user who no
  longer agrees leaves the community.
- Deleting the user, the document, or the community deletes the acceptance.

`CommunityRuleAcceptanceService` (exported by `CommunitiesModule`) owns the
only queries on this table; participation checks and endpoints must use it
rather than restating the SQL. Both methods take an optional `PoolConnection`
so they can run inside the caller's transaction.

- `getState(userId, communityId)` returns `currentVersion`,
  `currentDocumentId`, `acceptedAt`, and `acceptanceRequired`. The current
  document is the highest `version`, never the latest `published_at`, so a
  clock anomaly cannot change the answer. **A community with no published rule
  document requires no acceptance**; this keeps every community without rules
  working. Otherwise acceptance is required until the user has accepted the
  current version, so publishing a new version requires it again even from
  users who accepted the previous one.
- `accept(userId, communityId, version)` inserts
  `SELECT ?, d.id, d.community_id FROM community_rule_documents d WHERE
  d.community_id = ? AND d.version = ?`, restricted by `NOT EXISTS` to the
  community's highest version, with
  `ON DUPLICATE KEY UPDATE accepted_at = accepted_at`. Only the current
  version can be accepted, so a version published between a caller's check
  and the insert can never leave a stale acceptance behind. It returns `false`
  when that version is not the community's current one, including when the
  community has no rules, which callers map to their error response. A
  repeated acceptance still returns `true`, which relies on mysql2's default
  `FOUND_ROWS` connection flag; do not disable it on the pool. Because of that
  flag the result cannot tell a new acceptance from a repeat; a caller that
  needs to know, like `POST .../rules/acceptance`, reads `getState` first.
- `getLatestAcceptance(userId, communityId)` returns the highest version the
  user has accepted for the community and when, or `null`. It may be older
  than the current version, which is how a client can tell the user the rules
  changed since they agreed.

**Grandfathering.** Migration `012` records an acceptance of each backfilled
version 1 document for every subscriber of that community at migration time
and for its creator (an implicit member who wrote the legacy rules). Members
were never shown the legacy rules as a condition of joining, and blocking all
of them retroactively would be a regression. At migration time the only
documents that can exist are migration `009`'s backfill, so nothing else is
grandfathered. Users who join afterwards, and every version published after
the migration, require explicit acceptance. Grandfathered rows carry the
migration time as `accepted_at` and cannot otherwise be told apart from
explicit acceptances.

The MySQL-backed tests in
`src/communities/community-rule-acceptance.mysql.spec.ts` run migrations `009`
and `012` over a fixture and exercise these rules; they run with
`MYSQL_INTEGRATION_TEST=true` and `MYSQL_*` credentials that may create a
scratch database.

#### Rule acceptance API

Two routes on `CommunityRulesController` let a user see and record their own
acceptance. Both require a bearer token, take the user only from it (no route
or body field can name another user), and count against the global API rate
limits, reads and writes respectively; neither is exempt and there is no
dedicated bucket, because acceptance happens once per version. Like other
routes without `@AllowRestricted()`, a suspended or banned account receives
`403`.

**Nothing is enforced yet.** A missing acceptance blocks nothing until the
enforcement change lands. These routes ship first so clients can be built and
exercised while enforcement is reviewed.

`GET /communities/:name/rules/acceptance` returns:

```json
{
  "current_version": 2,
  "accepted_version": 1,
  "accepted_at": "2026-10-20T12:00:00.000Z",
  "acceptance_required": true
}
```

- `current_version` is the community's current rules version, or `null` when
  it has published none.
- `accepted_version` is the highest version this user has accepted, and
  `accepted_at` when; both are `null` if they have accepted none. Reporting the
  version rather than only a boolean lets a client say "the rules have changed
  since you agreed" instead of showing an unexplained prompt.
- `acceptance_required` is `true` until the user accepts the current version,
  and always `false` for a community without published rules.

It returns `400` for an invalid community name, `404` for an unknown community,
and `401` without a token. It requires no membership: someone deciding whether
to join must be able to see what they would be agreeing to.

`POST /communities/:name/rules/acceptance` takes `{ "version": 2 }` and
returns the same body, updated:

| Status | When                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| `201`  | The acceptance was recorded.                                                                         |
| `200`  | The user had already accepted that version; nothing is written and the original `accepted_at` stays. |
| `400`  | Invalid community name; `version` missing, not a JSON integer, or below 1; or any other body field.   |
| `401`  | No valid token.                                                                                      |
| `404`  | Unknown community.                                                                                   |
| `409`  | `Version N is not the current rules version (M)`: `version` is older or newer than the current one.  |
| `409`  | `This community has no published rules to accept`.                                                   |

Every `400`, `404` and `409` writes nothing. The two `409` messages are
distinct so a client can tell "reload the rules" from "there is nothing to
accept".

**`version` is required and must be current.** The client names the version
it displayed, and the server refuses anything else rather than recording
whatever is current. Otherwise a user could be bound to rules published
between reading them and submitting: "I agree to what I read" would become "I
agree to whatever is current", which is exactly what versioned acceptance
exists to prevent. Do not simplify this into a server-derived version. Because
`CommunityRuleAcceptanceService.accept` matches only the current version in
the insert itself, a version published mid-request also produces `409`, never
a stale acceptance. `version` must be a JSON number; `"2"` and `true` are
rejected rather than coerced.

**Repeats are idempotent and keep history.** A second acceptance of the same
version returns `200` and leaves the original row and `accepted_at` untouched,
so a repeated submit never rewrites when the user agreed. `user_id` comes from
the token, and `document_id` and `community_id` are derived by the insert,
never taken from the request.

**Acceptance neither requires nor creates membership.** Enforcement will make
joining conditional on having accepted, so acceptance must be reachable by a
non-member or joining becomes impossible. The intended client flow is two
deliberate calls: accept the rules, then `POST /communities/:name/subscribe`.

**Only real changes require reacceptance.** Publishing a new version makes
`acceptance_required` true again for everyone, while earlier acceptance rows
stay on record. A publish whose items hash equal to the current document
creates no version (see [Rules API](#rules-api)), so it never forces
reacceptance.

Accepting writes no `admin_actions` entry: the audit log is for
platform-administrative actions, and the acceptance row is itself the durable,
timestamped record.

#### Retiring the legacy `communities.rules` column

The API no longer reads or writes `communities.rules` (see the breaking-change
note under [Communities](#communities)). Two migrations then remove it:

- `013_backfill_late_community_rules` repeats migration `009`'s backfill, and
  `012`'s grandfathering of current subscribers and the creator, for
  communities created after `009` ran but before `POST /communities` stopped
  accepting `rules`. Their text would otherwise never have become a document.
  It touches only communities with non-blank legacy rules and no rule document
  at all, uses the same hash expression as `009` (a unit test pins both to the
  MySQL fixture digest), and is safe to re-run.
- `014_drop_communities_rules` runs `ALTER TABLE communities DROP COLUMN
  rules`. **It is irreversible**: afterwards the legacy text exists only in the
  version 1 documents from `009` and `013`, so take a backup first. It is not
  re-runnable after success.

**Ordering.** `014` must run after `009` and `013`, which the runner's
ascending numeric order enforces and a unit test in `migrate.spec.ts` pins.
Never renumber it to sort earlier: that would destroy the legacy rules before
they are copied. Prefer releasing the API change and `013` first, and merging
`014` once `009` and `013` have been applied and verified in the target
environment.

**Pre-drop verification.** This query counts communities whose non-blank
legacy rules do not appear, byte for byte, as the single rule of their
version 1 document. Zero means the column can be dropped; anything else means
do not drop yet:

```sql
SELECT COUNT(*) AS unmigrated
FROM communities c
WHERE c.rules REGEXP '[^[:space:]]'
  AND NOT EXISTS (
      SELECT 1
      FROM community_rule_documents d
      JOIN community_rules r ON r.document_id = d.id
      WHERE d.community_id = c.id
        AND d.version = 1
        AND r.position = 1
        AND CAST(CONVERT(r.body USING utf8mb4) AS BINARY)
            = CAST(CONVERT(c.rules USING utf8mb4) AS BINARY)
        AND NOT EXISTS (
            SELECT 1 FROM community_rules other
            WHERE other.document_id = d.id AND other.position <> 1
        )
  )
```

`014` runs the same check itself and refuses to drop while it is non-zero: it
inserts the count into a temporary table with `CHECK (unmigrated = 0)`, so the
migration fails with a `legacy_rules_have_documents` check-constraint error
(MySQL 8.0.16 or later), the `ALTER` never runs, and the version is not
recorded. A unit test keeps the query above identical to the one in the
migration.

After `013`, the only communities the check can report are ones created with
legacy rules after `009` that then published through `PUT
/communities/:name/rules`, so their version 1 is the published document rather
than the legacy text. Replace `COUNT(*) AS unmigrated` with `c.id, c.name` to
list them. Each needs a decision before the drop: the creator republishes rules
that include the legacy text, or an operator who has reviewed it confirms that
the text is superseded with
`UPDATE communities SET rules = NULL WHERE id = ?`. Then run the migration
again.

`src/database/drop-communities-rules.mysql.spec.ts` runs `009`, `012`, `013`
and `014` over a fixture and covers the catch-up backfill, both guard failures,
and the drop. It runs with `MYSQL_INTEGRATION_TEST=true` and `MYSQL_*`
credentials that may create a scratch database.

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

## Notifications

Notifications are stored in the `notifications` table (migration
`010_create_notifications`) and written only through `NotificationsService`
(see [Writing notifications](#writing-notifications)), and read through the
routes in [Inbox API](#inbox-api). No producer calls the service yet, and the
state-changing inbox routes (mark read or unread, mark all read, delete) are
added separately. Each row belongs
to one `recipient_id` and records one event: `type`, the optional `actor_id`,
the triggering `subject_type`/`subject_id`, an optional `community_id`, a
`metadata` snapshot, `read_at`, and `created_at`.

| `type`                | Produced when                                                                                         | Subject                     |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| `post_comment`        | someone comments on the recipient's post (`CommentsService.create`)                                   | the new comment             |
| `comment_reply`       | someone replies to the recipient's comment (`CommentsService.create`)                                 | the new reply               |
| `community_post`      | a post is created in a community the recipient belongs to (`PostsService.create`)                     | the new post                |
| `report_resolved`     | a report the recipient filed reaches `resolved` or `rejected` (`AdminReportsService.updateStatus`)    | the report                  |
| `restriction_applied` | the recipient is suspended or banned (`AdminRestrictionsService`)                                     | the restriction             |
| `restriction_lifted`  | the recipient's restriction is lifted (`AdminRestrictionsService`)                                    | the restriction             |
| `content_removed`     | a moderator removes the recipient's post or comment (`PostsService.remove`, `CommentsService.remove`) | the removed post or comment |

Adding a type requires a migration, as for the other enums.

**The subject is the triggering object**, not the object it happened to: a
reply notification points at the new reply, not at the post or comment that
was replied to. The unique key on
`(recipient_id, type, subject_type, subject_id)` therefore identifies one event
per recipient. Two replies to the same post are two subjects and two rows,
while a retried write of the same event collides. Producers insert with
`INSERT ... ON DUPLICATE KEY UPDATE id = id`, as for `community_subscriptions`,
so generation is idempotent and safe to retry. Report and restriction states
that produce a notification are terminal, so the key never hides a later,
distinct event.

**There is no foreign key on `subject_id`.** It is polymorphic, like
`votes.target_id` and `admin_actions.target_id`, so a subject can be deleted
while its notification survives (`content_removed` always refers to content
that is gone). Readers must tolerate a missing subject and must never join to
the subject, actor, or community to render a row; links to the subject are
best effort. Rows are rendered from `type` and `metadata` alone.

**`metadata` is an allowlisted snapshot** taken when the row is created, built
only by `buildNotificationMetadata(entry)` in
`src/notifications/notification-metadata.ts`, never by serialising request or
row data. Because `subject_id` has no foreign key, the post or comment can be
deleted while the notification survives, so the inbox renders from the row
alone and the snapshot is what keeps it readable, as `admin_actions.actor_username`
does for the audit log. Allowed keys depend on the type:

| `type`                | Required keys                             | Optional keys                                           |
| --------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `post_comment`        | `post_id`, `post_title`, `excerpt`        | `actor_username`, `community_name`                      |
| `comment_reply`       | `post_id`, `parent_comment_id`, `excerpt` | `post_title`, `actor_username`, `community_name`        |
| `community_post`      | `post_title`                              | `excerpt`, `actor_username`, `community_name`           |
| `report_resolved`     | `status` (`resolved` or `rejected`)       | none                                                    |
| `restriction_applied` | `restriction_type` (`suspension`, `ban`)  | `expires_at`, for a temporary suspension                |
| `restriction_lifted`  | `restriction_type`                        | none                                                    |
| `content_removed`     | none                                      | `community_name`, `post_title`, `excerpt`; never a name |

"Required" is enforced by the `NotificationEntry` type; at runtime the
allowlist validates whichever allowed keys are present.

- Unknown keys, including keys allowed only for another type, are dropped,
  not stored.
- Metadata that is `null`, an array, or not an object throws `TypeError`, as
  does a non-string value for an allowed key.
- `post_id` and `parent_comment_id` must match `^[A-Za-z0-9_-]{1,36}$`, the
  identifier pattern the audit log uses; `expires_at` must be an ISO-8601
  instant (same regex-plus-`Date.parse` check as the audit log); `status` and
  `restriction_type` must be one of their listed values. Anything else throws.
- `actor_username` and `community_name` must be 1-50 characters, matching
  their source columns; anything longer is rejected as a producer bug.
- `post_title` is capped at 300 Unicode code points (the `posts.title` column
  width) and `excerpt` at 200, taken from the start of the comment or post
  body. Over-long values are cut by code point, never by byte, and end in `…`
  within the cap, so multi-byte text is never split.
- When nothing survives, the column stores SQL `NULL`, not `{}`.

The `restriction_applied` snapshot carries only the type and expiry, matching
what the restricted user is told elsewhere.

**`read_at` is the read state.** `read_at IS NULL` is the unread predicate used
by the unread filter and the unread count; a timestamp records when the row
was read.

`community_id` is set for community-scoped types and `NULL` for platform-level
ones (`report_resolved`, `restriction_applied`, `restriction_lifted`). It is
denormalised from the subject so an inbox can be filtered per community without
polymorphic joins, and producers must derive it from the subject on the server,
never from a request. Deleting the recipient deletes their notifications,
deleting the actor sets `actor_id` to `NULL` (the snapshot keeps the username),
and deleting a community deletes its community-scoped notifications.

The indexes serve the inbox queries, all scoped to one recipient and newest
first: `idx_notifications_recipient_created` for the listing,
`idx_notifications_recipient_unread` for the unread filter and count, and
`idx_notifications_recipient_type` for the type filter.

Vote notifications are deliberately excluded: votes are high-volume and
low-signal, and nothing in the product currently justifies them.

There is no retention policy. The table grows without bound by design for now;
a retention or archival policy is an open question to settle before inbox
volume makes it pressing.

### Writing notifications

`NotificationsService` (in `NotificationsModule`, which producer modules
import) is the only code that inserts into `notifications`. Producers never
write their own insert, so recipient rules, self-notification suppression, the
metadata snapshot, and idempotency cannot drift between them. It deliberately
mirrors `AuditLogService`:

- `record(connection, entry)` writes on the caller's connection. Use it from
  inside a transaction; the row commits or rolls back with the action.
- `record(entry)` acquires a pool connection, writes, and releases the
  connection in `finally`. Use it only when the caller has no transaction.
- `recordMany(connection, entries)` is the fan-out form, for example one row
  per member for a new post. It validates every entry first, then writes one
  multi-row `INSERT` per `NOTIFICATION_BATCH_SIZE` (500) entries rather than
  one round trip per recipient. It always takes the caller's connection, so a
  multi-batch fan-out is atomic with the action. The producer decides between
  this and a single `INSERT ... SELECT`, and owns the ceiling on how many
  recipients one action may notify.

Like `AuditLogService.record`, passing an entry where the connection belongs,
or a connection where the entry belongs, throws `TypeError`.

Entries are a discriminated union, `NotificationEntry`, so the compiler checks
that each `type` has its `subjectType`, actor, community, and metadata fields;
`notification-entry.types.spec.ts` runs the compiler to prove that mismatches
fail. `assertNotificationEntry()` repeats the check at runtime, rejecting an
unknown `type`, a `subject_type` that does not match it, a missing or extra
actor or community, and malformed identifiers before anything is written.

**Moderation notifications never carry an actor.** `report_resolved`,
`restriction_applied`, `restriction_lifted`, and `content_removed` have
`actorId: null` in the type, and an entry that names one is rejected, so
`actor_id` is always `NULL` for them and their metadata has no username field.
The affected user must not learn which moderator or administrator acted; the
restriction response already withholds that, and the notification must not be
the leak.

**Self-notifications are suppressed centrally.** An entry whose `recipientId`
equals its `actorId` is dropped without an insert or an error, including
within a `recordMany` batch, so no producer needs its own check.

**Writes are idempotent.** Every insert ends in
`ON DUPLICATE KEY UPDATE id = id`, so repeating an event hits the unique key on
`(recipient_id, type, subject_type, subject_id)` and leaves the existing row,
including its metadata and `read_at`, unchanged. A retried action cannot fail
on, or duplicate, its notification.

**Transaction policy.** Producers pass their own connection, so a notification
commits with the action that caused it, and a comment can never exist while
its notification was lost. The cost is that a failed notification write rolls
back the user's action. That is accepted because the write is one bounded
insert whose only contention is its unique key, while writing after commit
would silently drop notifications from an inbox whose purpose is not to lose
them. This is the opposite of `AuthService.logoutAll`, which deliberately runs
outside its transaction: token revocation has an independent enforcement
backstop, and a notification has none. The same reasoning is recorded at the
service; do not move notification writes after commit without revisiting it.

### Inbox API

`NotificationsController` and `NotificationInboxService` serve the read side
of the inbox under `/notifications`, not `/me/notifications`: like
`POST /reports` and `POST /votes`, the authenticated user's own resource lives
at the resource root and its owner comes from the token. Nothing in the API
uses a `/me` namespace.

**Ownership.** `recipient_id` is always bound from `request.user.id`. No route
accepts a recipient in its path, query, or body; sending `recipient_id` or any
other unknown query parameter returns `400`. Another user's notification is
reported as `404`, never `403`, so a probe cannot confirm that an ID exists,
matching the admin-route convention. All three routes require a bearer token
and return `401` without one.

`GET /notifications` returns the standard collection envelope:

```json
{
  "items": [
    {
      "id": "notification-id",
      "type": "comment_reply",
      "actor_username": "someone",
      "subject_type": "comment",
      "subject_id": "comment-id",
      "community_id": "community-id",
      "community_name": "gardening",
      "metadata": {
        "post_id": "post-id",
        "parent_comment_id": "comment-id",
        "excerpt": "Same here."
      },
      "read_at": null,
      "created_at": "2026-10-22T08:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

It accepts:

- `read`: optional `true` (read only) or `false` (unread only, `read_at IS
  NULL`); omitted returns both. Any other value returns `400`.
- `type`: optional, one of `NOTIFICATION_TYPES`, the exported list that mirrors
  the column enum (a unit test pins it to migration `010`).
- `community_id`: optional, 1-36 letters, digits, `_` or `-`.
- `page` (`1-10000`, default `1`), `limit` (`1-100`, default `20`), and `sort`
  (`new`, the default, or `oldest`).

Results are ordered by `created_at` then `id`, both descending for `new` and
both ascending for `oldest`, so offset paging returns each notification
exactly once. An empty inbox returns `200` with `items: []` and `total: 0`.

**Rows render from the notification alone.** The queries select only the
notification's own columns and never join to posts, comments, users, or
communities. A deleted subject therefore never drops a row or breaks it, and
`subject_id` may point at something that no longer exists. `actor_username`
and `community_name` come from the metadata snapshot, so a deleted actor
(`actor_id` set to `NULL`) or a renamed community still renders as it was when
the notification was created. `actor_id` is never returned, and
`actor_username` is always `null` for the moderation types, so no response
names the moderator or administrator who acted. `metadata` returns only the
documented snapshot keys other than those two, or `null`.

`GET /notifications/unread-count` returns `{ "unread": 7 }`, counting the
caller's rows with `read_at IS NULL`; an empty inbox returns
`{ "unread": 0 }`. It is a separate route rather than a field on the listing on
purpose: clients poll the badge far more often than they open the inbox, and
this query reads one index range without fetching rows or computing an offset.
Do not fold it into the listing. Clients should poll this route, not the
listing. It is declared before `GET /notifications/:id` because
`unread-count` also matches the ID pattern; a controller test fails if the
order is reversed.

`GET /notifications/:id` returns one notification in the same item shape. An
invalid ID returns `400`; an unknown ID, or one belonging to another user,
returns `404`. **Reading a notification does not mark it read.** Marking read
is an explicit client action owned by the state-changing routes, which keeps
the badge truthful when a client prefetches.

**Restricted accounts can read their inbox.** All three routes are marked
`@AllowRestricted()`, so an account under an active suspension or ban can
reach them. Otherwise the user who most needs "your account was suspended,
here is the type and expiry" would be the one user who cannot read it. This
discloses nothing new: `AuthGuard`'s own `403` already returns the restriction
type and expiry, and moderation notifications carry no moderator identity.
State-changing notification routes must not be marked `@AllowRestricted()`.

**Indexes.** Each query keeps a prefix of one of migration `010`'s indexes:
the listing uses `idx_notifications_recipient_created`, the unread filter and
unread count use `idx_notifications_recipient_unread`, and the type filter
uses `idx_notifications_recipient_type`. The `community_id` filter, and `read`
combined with `type`, are served by the recipient prefix and filtered from
there. `src/notifications/notification-inbox.mysql.spec.ts` checks the plans
with `EXPLAIN` against migration `010`; it runs with
`MYSQL_INTEGRATION_TEST=true` and `MYSQL_*` credentials that may create a
scratch database.

**Rate limits.** The routes use the global read buckets (120 reads and 300
requests per IP per minute) and are not exempt. Polling `unread-count` every
30 seconds costs two requests a minute; if a dashboard pattern later exceeds
the bucket, add an explicit documented override rather than a bypass.

**Real-time delivery is a non-goal.** There is no WebSocket, SSE, or event-bus
support in the API, and adding a transport would be a new architectural
dependency nothing here requires. Polling `unread-count` is the delivery
mechanism.

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
