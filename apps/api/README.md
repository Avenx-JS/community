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

#### Rules enforced by triggers

MySQL 8 refuses a `CHECK` constraint that names a column whose foreign key
has a referential action (`ON DELETE SET NULL` or `CASCADE`; error 3823).
The "actor only with a timestamp" rules on the `_by` columns, and the
self-report rule on `user_reports`, name exactly such columns, so each is a
pair of `BEFORE INSERT` and `BEFORE UPDATE` triggers instead of a `CHECK`:

| Rule | Table | Migration |
| --- | --- | --- |
| `chk_user_reports_not_self` | `user_reports` | `002_create_user_reports` |
| `chk_user_restrictions_lift` | `user_restrictions` | `003_create_user_restrictions` |
| `chk_posts_lock`, `chk_posts_removal` | `posts` | `017_add_post_and_comment_content_state` |
| `chk_comments_lock`, `chk_comments_removal` | `comments` | `017_add_post_and_comment_content_state` |
| `chk_communities_deletion` | `communities` | `022_add_community_deletion` |
| `chk_communities_suspension` | `communities` | `025_add_community_suspension` |
| `chk_posts_pin` | `posts` | `026_add_post_pinning` |

Each trigger is named after its rule (`trg_posts_pin_insert`,
`trg_posts_pin_update`) and raises exactly what the `CHECK` would have: error
3819 (`ER_CHECK_CONSTRAINT_VIOLATED`) with MySQL's own message, `Check
constraint 'chk_posts_pin' is violated.` Its condition is `IF NOT (<the CHECK
expression>)`, which keeps `CHECK` semantics for `NULL`. The foreign keys keep
their `ON DELETE SET NULL`: a referential action does not fire triggers, and
nulling an actor never breaks a rule. Rules on columns without a referential
action (`chk_user_reports_context`, `chk_user_restrictions_expiry`) stay
ordinary `CHECK` constraints. `src/database/check-trigger-rules.ts` is the
list of rules; `check-trigger-rules.spec.ts` keeps the migrations and the
snapshot in step with it and fails if a `CHECK` on such a column is added.

**`DELIMITER`.** Trigger bodies contain semicolons, so the SQL files switch
the delimiter around them (`DELIMITER $$ … DELIMITER ;`), as the `mysql` client
and MySQL Workbench expect. `npm run migrate` and the MySQL test suites split
scripts the same way (`src/database/sql-script.ts`). Load `data/community.sql`
with the `mysql` client (`mysql -u … community < data/community.sql`) or an
editor that honours `DELIMITER`.

**Privileges.** Creating triggers needs the `TRIGGER` privilege. With binary
logging enabled (the MySQL 8 default) it also needs `SUPER` or
`SET_USER_ID`, or the server setting `log_bin_trust_function_creators = 1`.
Grant these to the migration operator, not to the API runtime user.

#### Search indexes

Migration `015_add_fulltext_search_indexes` adds MySQL native `FULLTEXT`
indexes for word search. No endpoint queries them yet; they exist for the
search endpoint, which must use exactly these column lists:

| Index | Table | Query it supports |
| --- | --- | --- |
| `ft_posts_title_content` | `posts` | `MATCH (title, content) AGAINST (? IN BOOLEAN MODE)` |
| `ft_comments_content` | `comments` | `MATCH (content) AGAINST (? IN BOOLEAN MODE)` |
| `ft_communities_name_description` | `communities` | `MATCH (name, description) AGAINST (? IN BOOLEAN MODE)` |

A `MATCH` column list must equal an index's column list exactly, which is why
each table has one multi-column index rather than one per column. A
leading-wildcard `LIKE '%term%'` cannot use a B-tree index and scans the whole
table; on posts and comments that would make each public search request a
scan of all content. `GET /communities?search=` still uses its `LIKE` substring
match unchanged; moving it to `MATCH` changes its matching and ordering and is
the search endpoint's decision.

**Why native FULLTEXT.** An external engine (Elasticsearch, Meilisearch,
Typesense) searches better, but adds a service to run, a sync pipeline to keep
consistent, and a second source of truth for a project that is deliberately a
single MySQL instance. `LIKE '%…%'` everywhere has the scan problem above and
no word boundaries, relevance or multi-word handling. Trigram or
generated-column prefix indexes serve prefix search, not word search.

**Query in boolean mode.** Natural-language mode filters by relevance, so
whether a word that occurs in (nearly) every row is returned depends on the
engine and version: MyISAM drops it at its 50%-of-rows threshold, while InnoDB
on MySQL 8.0.46 was measured to still return it. Boolean mode returns every
row containing the word by definition, so search does not depend on that
behaviour.

**Server-configuration limitations.** These are server settings, not schema,
so no migration can change them:

- `innodb_ft_min_token_size` defaults to 3, so one- and two-character terms
  such as `go` or `C` match nothing. The search endpoint must reject queries
  shorter than 3 characters rather than return a silent empty result. Changing
  the setting needs a server restart and a rebuild of every `FULLTEXT` index.
- InnoDB's built-in stopword list (`the`, `about`, `with`, …) removes common
  English words from the index, so they also match nothing. No custom stopword
  table is shipped: changing `innodb_ft_server_stopword_table` takes effect only
  for indexes built afterwards, which means rebuilding them.

`fulltext-search-indexes.mysql.spec.ts` pins both limitations, together with
boolean mode returning common words, so the endpoint's validation rules are
backed by a test.

**Users are excluded.** Usernames are single tokens matched by prefix. The
existing `UNIQUE` B-tree index on `users.username` already serves
`LIKE 'term%'`, so user search must use a prefix match. Do not add a
`FULLTEXT` index on `users`.

**Write cost.** Every insert and update of an indexed column also updates the
full-text index. That covers `POST /communities`, `POST /posts`,
`POST /posts/:postId/comments` and the editing endpoints. InnoDB batches these
writes through its full-text cache, so the per-write cost is small but not
zero. Committed rows are searchable immediately.

**Migration cost.** The first `FULLTEXT` index on an InnoDB table adds the
hidden `FTS_DOC_ID` column and rebuilds the whole table. Each index in 015 is
the first on its table, so on populated `posts` and `comments` tables the
migration is slow and I/O heavy rather than instant. It runs as online DDL
(`ALGORITHM=INPLACE`), but adding a `FULLTEXT` index does not permit concurrent
writes, so schedule it in a maintenance window. It is not safely re-runnable
after partial application. Before completing it by hand, check which indexes
exist:

```sql
SELECT table_name, index_name FROM information_schema.statistics
WHERE table_schema = DATABASE() AND index_type = 'FULLTEXT';
```

#### Index coverage for content listings

Migration `018_add_content_listing_indexes` adds the B-tree indexes behind the
vote aggregate and the newest-first content listings. It changes no response;
only query plans change.

| Index | Columns | Query it serves |
| --- | --- | --- |
| `idx_votes_target` | `votes (target_type, target_id, value)` | `VotesService.vote`'s `SUM(value) … WHERE target_type = ? AND target_id = ?` |
| `idx_posts_community_created` | `posts (community_id, created_at, id)` | One community's posts, newest first (`GET /posts?community_id=…` before pinning; see [Pins in listings](#pins-in-listings)) |
| `idx_posts_author_created` | `posts (author_id, created_at, id)` | One author's posts, newest first |
| `idx_comments_author_created` | `comments (author_id, created_at, id)` | One author's comments, newest first |
| `idx_comments_parent_created` | `comments (parent_id, created_at, id)` | Paginated replies of one comment (`GET /comments/:id/replies`) and their grouped `reply_count` |
| `idx_comments_post_created` | `comments (post_id, created_at, id)` | `CommentsService.findThread` (`GET /posts/:postId/comments`) and the post's root comments (`GET /posts/:postId/comments/top-level`) |

**The `(filter, created_at, id)` shape.** Every list orders by
`created_at DESC, id DESC` (threads ascending). With the filter column first,
the matching rows sit in the index already in that order, and MySQL reads them
backwards (or forwards) without a filesort. `id` is included because it is the
pagination tiebreaker: without it, rows sharing a `created_at` still need
sorting, and the plan is not fully index-ordered. A new listing should reuse
this shape rather than filter on a single-column index and sort.

**`idx_votes_target` is covering.** Before it, no index on `votes` led with
`target_type` (`unique_user_target` leads with `user_id`), so every vote
scanned the whole table to recompute the score. Its leading
pair matches the `WHERE`, and `value` is included so the sum is computed from
the index alone, without reading a row.

**The composites replace the implicit foreign-key indexes.** MySQL creates a
single-column index for a foreign key that has none, and drops that implicit
index by itself as soon as another index leads with the same column. Adding
the composites therefore removes the implicit indexes on `posts(author_id)`,
`posts(community_id)`, `comments(post_id)`, `comments(author_id)` and
`comments(parent_id)`, and each foreign key is then backed by its composite
(measured on MySQL 8.0.46; `content-listing-indexes.mysql.spec.ts` asserts
it). Do not drop a composite that is the only index leading with a foreign-key
column: MySQL refuses to, because the constraint needs it. Fresh and migrated
installations end in the same state, since `data/community.sql` also creates
the composites with `CREATE INDEX` after each table.

**Migration cost.** On populated `posts`, `comments` or `votes` tables, index
creation locks or copies the table. Consider running each statement as online
DDL (`ALGORITHM=INPLACE, LOCK=NONE`) on a populated database. The migration is
not safely re-runnable after partial application. Before completing it by hand,
check which of the six indexes exist:

```sql
SELECT table_name, index_name FROM information_schema.statistics
WHERE table_schema = DATABASE()
  AND index_name IN ('idx_votes_target', 'idx_posts_community_created',
    'idx_posts_author_created', 'idx_comments_author_created',
    'idx_comments_parent_created', 'idx_comments_post_created')
GROUP BY table_name, index_name;
```

`content-listing-indexes.mysql.spec.ts` seeds a few thousand rows and asserts
each query above is planned on its index with no filesort (and `Using index`
for the vote aggregate), so an index that exists but is not chosen fails the
suite.

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

| Action                  | Target        | Allowed metadata                            |
| ----------------------- | ------------- | ------------------------------------------- |
| `report_status_changed` | `report`      | `from_status`, `to_status`, `resolution`    |
| `user_suspended`        | `user`        | `restriction_id`, `expires_at`, `report_id` |
| `user_banned`           | `user`        | `restriction_id`, `report_id`               |
| `restriction_lifted`    | `restriction` | `restriction_id`, `restriction_type`        |
| `user_role_changed`     | `user`        | `from_role`, `to_role`                      |
| `community_suspended`   | `community`   | `community_name`, `reason`                  |
| `community_restored`    | `community`   | `community_name`                            |
| `community_updated`     | `community`   | `community_name`, `fields`                  |

The three `community_*` actions and the `community` target were added by
migration `025_add_community_suspension`. No endpoint writes them yet; they
exist so the community-administration endpoints that follow need no enum
migration of their own. `community_name` is a snapshot of the name (1-50 of
`[A-Za-z0-9_-]`, the column width), so an entry stays readable after the
community is gone, as `actor_username` does for the actor. `reason` is the
suspension reason, plain text of at most 2,000 characters. `fields` names
which fields changed, as a comma-separated list of editable fields (today only
`description`), never their old or new values: the log records that a change
happened, not a content diff. The `AuditEntry` type pairs each action with its
target, so a community action with any other `target_type` does not compile.

**Both enums are append-only.** `admin_actions.action` and `target_type` may
only ever gain members at the end, in the same order as `ADMIN_ACTIONS` and
`ADMIN_ACTION_TARGETS` in `audit-log.service.ts`. Appending is an in-place
change in MySQL 8 that keeps every stored value; inserting elsewhere renumbers
stored values and rebuilds the table, and removing a member breaks existing
rows. The constants, the `AuditEntry` union, the metadata allowlist and the
migration change together. `ListAdminActionsDto` validates its filters against
the same constants, so `GET /admin/audit-log` accepts every new value as a
filter without a code change.

The service builds metadata from this allowlist and drops extra runtime keys
(an unknown key is never stored; an invalid value for an allowlisted key, or a
non-object metadata value, throws). Passwords and hashes, tokens, session
identifiers, email addresses, and free text such as `lift_reason` or
`resolution_note` are never copied to audit metadata; the only free text
allowed is `reason` on `community_suspended`, which no other action accepts.
Audit entries themselves are sensitive and may only be exposed
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

#### `GET /admin/audit-log/:id`

Returns a single entry, so that a report's history, a restriction's
provenance, or a link in an incident write-up can point at one entry. List
URLs cannot do that reliably, because page offsets shift as new actions are
recorded. The route sits on the same controller and guards as the list:
`401` for a missing, malformed or expired token, and `403` for members and
platform moderators. An `id` that fails the route-parameter pattern
(1–36 of `[A-Za-z0-9_-]`) returns `400`. An unknown `id` returns
`404 Audit entry not found`. Every administrator can see the whole table, so
nothing is owner-scoped and there is no reason to hide a `403` behind a `404`.

**The item is identical to the list item.** The route returns the same object
that `GET /admin/audit-log` returns in `items[]`, field for field, including
`metadata` and the `created_at` format. Both routes use one mapper
(`toAdminActionItem`) and one OpenAPI class (`AdminActionItemResponse`). A test
fetches every entry both ways and compares the results. `metadata` is the
stored allowlisted JSON, or `null`. It was validated when it was written, and
it is not re-validated or re-shaped when it is read.

**The target is never resolved.** The lookup is a primary-key
`SELECT … FROM admin_actions WHERE id = ? LIMIT 1` with no join to `users`,
`user_reports` or `user_restrictions`. `target_id` is polymorphic and has no
foreign key on purpose, so that an entry outlives the thing it refers to. A
nested target object would have nothing to show once the target is deleted,
so the detail route returns the raw id, just as the list does. The actor is
treated the same way: `actor_id` becomes `null` when the account is deleted,
and `actor_username` keeps the snapshot.

**Entries are immutable.** There is no `PATCH`, `PUT` or `DELETE` on
`/admin/audit-log/:id`, and adding one is out of scope by design, not an
omission. The route falls under the global read rate-limit buckets, with no
dedicated bucket and no exemption.

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
data-classification guarantee that email is returned only to its owner, by
`GET /users/me`. Neither route returns password hashes, credentials, tokens,
session identifiers, or auth-rate-limit keys. The public `GET /users/:username`
profile is described in "Public user profiles" and never includes email.

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
reporter/reported usernames. A deleted reporter is shown as `null`. The queue
reads reports through the account they concern (`reported_user_id`), so the
reported username is always present: since migration 016 a report whose
account was deleted is kept with `reported_user_id` set to `NULL` and is left
out of the queue, its counts and the detail route, rather than deleted.
Free-text descriptions are returned only by the detail route. An empty page
returns `200` with an empty `items` array.

The queue never joins a report's target (`target_type`/`target_id`, see
[Reports](#reports)). A report whose target has since been removed still
renders, and so must every future reader: treat the target as possibly
missing. Today the queue holds only `user` targets, and its request and
response shapes are unchanged; surfacing post, comment and community targets
is separate work.

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

### Changing your password

`POST /auth/password/change` with a bearer token and
`{ "current_password": "...", "new_password": "..." }` changes the password of
the token's account. No body field identifies the account, and unknown
properties such as `user_id` are rejected.

| Status | When |
| --- | --- |
| `204` | The password is changed and every session of the account is revoked. No body and no new tokens. |
| `400` | A field is missing, not a string, outside 12–128 characters, an unknown property is present, or `new_password` equals `current_password`. |
| `401` | No valid bearer token, or `current_password` is wrong. Nothing is written. |
| `409` | The password changed concurrently between the check and the write. Nothing is written. |
| `429` | The password-change rate limit is exceeded; see `Retry-After`. |

**Every session is revoked, including the caller's own.** The access token
used for the request is refused on its next use, every refresh token of the
account is rejected, and no replacement tokens are returned. Clients must
expect their own credentials to stop working immediately and send the user
back to sign in with the new password. Keeping the calling session alive
would be friendlier, but a user changing a password because they fear
compromise could not tell whether the surviving session was theirs or the
attacker's.

**Restricted accounts can change their password.** The route carries
`@AllowRestricted()`, like logout and logout-all: a suspension or ban limits
participation, not account hygiene, and a suspended user must still be able
to replace a compromised password. The restriction itself is unaffected.

The change runs in one transaction. It reads the user row with
`SELECT … FOR UPDATE`, verifies `current_password` with the same check as
login, and writes a new Argon2id hash with
`UPDATE … WHERE id = ? AND password_hash = ?`, binding the hash that was
verified. Concurrent changes therefore serialise: exactly one succeeds, and
the other gets `401` (it verified against the new hash) or `409` (the
compare-and-set matched no row). The account never ends up with a password
nobody chose. An account still on a legacy `scrypt` hash can change its
password, and the new hash is Argon2id.

Session revocation runs **after** the commit and its failure does not fail
the request: the password is already changed, and the client must not retry
against a password that no longer exists. Unlike a restriction, nothing on the
request path backstops a failed revocation. Until it is repeated, surviving
access tokens work for up to their 15-minute lifetime, and surviving refresh
tokens keep issuing new ones until they expire (30 days) or are revoked by
`POST /auth/logout-all`. The failure is logged as a warning without the user,
passwords, or hashes. An operator who sees it can revoke that account's
sessions; making refresh reject tokens issued before the last password change
would need a `password_changed_at` column and is not implemented.

No audit entry is written: `admin_actions` records platform-administrative
actions, and a user changing their own password is not one. **Follow-up:** a
`password_changed` notification would tell users about a change they did not
make, but `notifications.type` is an `ENUM` that needs a migration for a new
value, and the user cannot read the inbox until signing in again anyway. It is
deliberately not part of this endpoint.

### Authentication rate limits

Login, registration, and refresh requests use atomic fixed-window counters in
the shared MySQL `auth_rate_limits` table. Default limits are 20 login attempts
per IP and 10 per normalized account per 15 minutes; 5 registrations per IP
and 3 per normalized username/email per hour; and 30 refresh attempts per IP
and 10 per refresh token per hour. Password changes are limited to 10 per IP
and 5 per account (the token's user ID) per hour, because the endpoint
verifies a password and is therefore a guessing oracle for anyone holding a
stolen access token; the global write limit is far too loose for that.
Exceeded limits return HTTP `429` with a
`Retry-After` header. Login failures remain generic, and no account lockout is
applied. The exported `AuthRateLimitService.enforceSignals()` method uses the
same shared counters and can be reused for future API route throttles.

Limits are configurable with `AUTH_LOGIN_IP_MAX`,
`AUTH_LOGIN_IP_WINDOW_SECONDS`, `AUTH_LOGIN_ACCOUNT_MAX`,
`AUTH_LOGIN_ACCOUNT_WINDOW_SECONDS`, `AUTH_REGISTER_IP_MAX`,
`AUTH_REGISTER_IP_WINDOW_SECONDS`, `AUTH_REGISTER_ACCOUNT_MAX`,
`AUTH_REGISTER_ACCOUNT_WINDOW_SECONDS`, `AUTH_REFRESH_IP_MAX`,
`AUTH_REFRESH_IP_WINDOW_SECONDS`, `AUTH_REFRESH_TOKEN_MAX`,
`AUTH_REFRESH_TOKEN_WINDOW_SECONDS`, `AUTH_PASSWORD_CHANGE_IP_MAX`,
`AUTH_PASSWORD_CHANGE_IP_WINDOW_SECONDS`, `AUTH_PASSWORD_CHANGE_ACCOUNT_MAX`,
and `AUTH_PASSWORD_CHANGE_ACCOUNT_WINDOW_SECONDS`. Values must be integers
from 1 to 86400.
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

`GET /users/:username` returns the public profile of the exact account with
HTTP `200`:

```json
{
  "username": "sample_user",
  "display_name": "Sam",
  "bio": "Grows tomatoes.",
  "created_at": "2026-10-21T20:00:00.000Z"
}
```

`display_name` and `bio` are user-authored public text and are `null` until the
owner sets them. `created_at` is the join date, public in the same way a
community's `created_at` is. The public profile never exposes the account ID,
email, role, `last_seen_at`, password, or password hash. If the username does
not exist, the endpoint returns HTTP `404`:

```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found"
}
```

### Activity listings: posts, comments and communities

Three public routes show what an account has written and where it takes
part, so a reader, or a moderator weighing a report, can see who they are
dealing with without querying the database. None needs a bearer token; all
three remain subject to the global read rate limits. They are the cheapest
kind of indexed listing but also the natural tool for scraping one person's
history, so they are candidates for a documented per-route override if abuse
appears, never for an exemption.

Each route resolves the username first (`SafeRouteParamPipe`, then
`username = ? AND deleted_at IS NULL`): an unknown username is `404 User not
found` before any other rule applies, and a malformed one is `400`. A
**deleted account is `404`** under its placeholder username as well as its
old one, rather than serving a feed of retained content attributed to a
placeholder. Each returns `{ "items", "page", "limit", "total" }`; `page` is
`1` to `10000` (default `1`) and `limit` `1` to `100` (default `20`), and an
out-of-range value or unknown query property is `400`. An account without
qualifying activity gets `200` with `items: []` and `total: 0`.

**What is excluded.** A listing shows only what a reader of the community
could see:

| Route | Excluded |
| --- | --- |
| `/posts` | posts with `removed_at` set; posts in a deleted (`deleted_at`) or suspended (`suspended_at`) community |
| `/comments` | comments with `removed_at` set; comments on a post with `removed_at` set; comments in a deleted or suspended community |
| `/communities` | deleted and suspended communities; a community the user is only subscribed to; a community where the user's only content is excluded above |

The suspended-community rule is stricter than the rest of the API today:
suspension (`communities.suspended_at`, migration 025) is not yet enforced on
`GET /posts` and the other reads. These listings apply both predicates
(`listedCommunitySql`), and each other read must add the second one when
suspension is enforced.

#### `GET /users/:username/posts`

Optional `sort`: `new` (default, `created_at DESC, id DESC`) or `oldest`
(`created_at ASC, id ASC`). Items are the same post type as `GET /posts` and
`GET /posts/:id` (`PostResponse`), so a client has one post type. Served by
`idx_posts_author_created (author_id, created_at, id)` in either direction
without a filesort.

#### `GET /users/:username/comments`

Same `sort` as the post feed. Items are flat:

```json
{
  "id": "comment-id",
  "post_id": "post-id",
  "content": "Comment body",
  "created_at": "2026-10-22T08:00:00.000Z",
  "edited_at": null,
  "post_title": "The post it is on",
  "community_name": "general",
  "score": 2
}
```

**Not the thread node.** `GET /posts/:postId/comments` returns a recursive
`CommentResponse` with a `replies` array. An author listing has no tree, and
nodes with empty `replies` would invite clients to treat every comment as a
root, so this route has its own flat item type (`UserCommentResponse`).

**Why this listing joins.** `post_title` and `community_name` come from a
join to `posts` and `communities`. The [notification inbox](#notifications)
deliberately forbids joins, because a notification's subject may be gone and
its context must be stored. A comment's post always exists:
`comments.post_id` is a real foreign key with `ON DELETE CASCADE`, as is
`posts.community_id`, so the join can never drop or orphan a row. The
difference from the inbox rule is deliberate. The query reads
`idx_comments_author_created (author_id, created_at, id)` first and joins
each post and community by primary key (`STRAIGHT_JOIN` keeps that order), so
it needs no filesort.

#### `GET /users/:username/communities`

Items are `{ "name", "description", "role" }`, ordered by `name` ascending.
There is no `sort`: a recency order would reveal when the person was last
active there.

**Visibility decision.** A membership list is personal information. `#15`
minimised PII in responses, and `GET /communities/:name/members` stays behind
a moderator check because a roster is a targeting primitive; every community
one named person belongs to is the same information from the other
direction. This route therefore lists **only the communities the user's own
public activity already reveals**:

| `role` | Rule |
| --- | --- |
| `creator` | the user created the community |
| `moderator` | the user is a listed moderator (`GET /communities/:name/moderators` is public) |
| `contributor` | the user has a visible post, or a visible comment on a visible post, there |

The strongest role wins. **Membership alone is never published**: everything
in the list is already discoverable by reading the community, so the route
reveals nothing new, whereas a subscription list would reveal reading habits,
which nothing else in the API exposes. No subscription timestamp, nor any
field derived from `community_subscriptions`, is returned; the query does not
read that table at all. `role` is the community role, never the platform
role.

*Rejected alternative:* publishing raw `community_subscriptions`. It is
simpler and closer to the route's name, but needs a per-user visibility
setting (its own column and endpoint, a separate issue) and must not ship
without one.

The query unions the four sources, each starting from an index led by the
user (`idx_communities_creator_id`, `idx_community_moderators_user_id`,
`idx_posts_author_created`, `idx_comments_author_created`), so its cost grows
with the person's activity, not with the number of communities.

**Not yet covered.** Once user blocking exists, a blocked viewer reading a
blocker's activity must follow whatever the blocking enforcement decides;
these routes do not anticipate it.

`user-activity.mysql.spec.ts` runs the exclusion matrix, each visibility
branch, paging and both sort directions on a real server, and asserts that
both feeds use their composite index without a filesort and that no branch
of the community listing scans a base table.

### Own account: `GET /users/me` and `PATCH /users/me`

Both require a bearer token and act only on the account the token belongs to;
no path, query or body field can name another account.

`GET /users/me` returns the caller's own record with HTTP `200`:

```json
{
  "id": "6f1c…",
  "username": "sample_user",
  "email": "sample_user@example.com",
  "display_name": "Sam",
  "bio": "Grows tomatoes.",
  "role": "user",
  "created_at": "2026-10-21T20:00:00.000Z"
}
```

It is marked `@AllowRestricted()`: a suspended or banned account can still read
the account it is asking about, as it can still log out.

**`GET /users/me` is the only route that returns the caller's email** (and the
only one returning their role to them). This is consistent with the data
classification below: email is private account data, which means it is kept
from *other* users, not from the account owner. `last_seen_at` is excluded even
here: it is activity telemetry for admin analytics, not a profile field, and
returning it would invite clients to treat it as a presence signal it is not.
Password hashes, tokens, token hashes and session fields are never returned.

`PATCH /users/me` updates `display_name` (at most 50 characters, single line)
and `bio` (at most 500 characters, line breaks allowed), and returns the same
shape as `GET /users/me`:

- Values are trimmed. A field trimmed to empty (`""`) is stored as `NULL`,
  which is how a field is cleared; an explicit `null` is rejected.
- An absent field is left unchanged; `{ "bio": "…" }` does not touch
  `display_name`.
- An empty body is `400`, as are over-long values, non-strings and control
  characters.
- Any other property is `400` and nothing is written. That includes
  `username`, `email`, `role`, `id`, `created_at` and `password_hash`: the
  global `ValidationPipe`'s `forbidNonWhitelisted` is what keeps them
  unsettable, and `users.e2e-spec.ts` pins each one.
- It is **not** `@AllowRestricted()`: a suspended or banned account may read its
  profile but not change it (`403` with the restriction body).

Neither route has a dedicated rate-limit bucket; the global per-IP and
per-account buckets apply. Express matches routes in declaration order, so
`@Get('me')` is declared before `@Get(':username')`;
`users.controller.spec.ts` pins that order. (Today `me` would be rejected by
the three-character username minimum instead, which hides a misordering.)

**Not editable here, deliberately:**

- **`username`** is referenced by `GET /users/:username`, by
  `ManageModeratorDto`, by report submission, and by the
  `admin_actions.actor_username` snapshot. Renaming is a cross-cutting change
  with its own migration and audit questions.
- **`email`** is the account-recovery credential. Changing it must require the
  current password and a verification round trip to the new address, and this
  project has no email delivery yet. An unverified change through a profile
  `PATCH` would let anyone holding a stolen access token take over the
  account's recovery path. Left as follow-up.
- **`role`** is assignable only by an operator in the database (see "Platform
  roles").

### Route namespace for account-scoped resources

`/users/me` introduces `/users/me/*` as the namespace for sub-resources of the
authenticated user's own account. **New account-scoped sub-resources go under
`/users/me/*`.** The existing `/subscriptions` and `/notifications` are
resource-root routes that take the actor from the token; they are published
API and stay where they are rather than being renamed.

### Deleting your own account

`DELETE /users/me` with body `{ "password": "<current password>" }` deletes the
caller's account and returns `204` with no body. The password (12–128
characters, as for login) is required because this is the only irreversible
self-service action in the API: a stolen access token alone must not be enough.

**Deletion anonymises; it does not erase.** The `users` row is the parent of
almost every foreign key, and deleting it would cascade:

- `posts.author_id` and `comments.author_id` cascade, and `comments.post_id`
  cascades in turn, so one account's departure would delete every other user's
  replies on its posts.
- `communities.creator_id` cascades, taking the community, its rules,
  subscriptions and content with it.
- `user_restrictions.user_id` cascades, and `user_reports.reported_user_id` is
  `SET NULL`, so a banned user could delete their account to erase the ban and
  detach every report about them, then register again.

So the row is kept, no cascade ever fires, and what is removed is everything
that identifies or authenticates the person. Soft delete alone (a flag with the
row untouched) was rejected because it keeps the email, the username and a
working credential. Reassigning content to a shared "deleted user" row was
rejected because every author-scoped query would have to special-case that id,
and one missed case would attribute live content to it.

**What changes, in one transaction** (on one connection; any failure rolls the
whole operation back and the account stays fully intact):

1. The `users` row is locked `FOR UPDATE`. An already-deleted account is `404`.
2. The password is verified with the same path as login. A mismatch is `401`
   and nothing is written.
3. A community creator is refused with `409` (below).
4. The row is anonymised:

   | Column | Becomes |
   | --- | --- |
   | `username` | `deleted_<id>` |
   | `email` | `deleted_<id>@invalid` |
   | `password_hash` | `deleted`, which no password matches: it is neither an Argon2id nor a scrypt hash, so verification fails closed (pinned in `auth.service.spec.ts`) |
   | `display_name`, `bio`, `last_seen_at` | `NULL` |
   | `deleted_at` | `UTC_TIMESTAMP()` |

   `username` and `email` are `UNIQUE NOT NULL`, so they get per-account
   placeholders built from the account's own id rather than `NULL`. Ids are
   UUIDs, and their hyphens fail the registration username pattern; `.invalid`
   is reserved by RFC 2606, cannot be delivered to, and fails email validation.
   No one can register a placeholder in advance and block a deletion.
5. The account's private state is deleted: its `community_subscriptions`,
   `community_notification_preferences`, and the `notifications` it received.
6. Every session and refresh token is revoked.

**Kept:** posts, comments, votes, `community_rule_acceptances`,
`community_moderators` rows, every report about or by the account, and every
restriction on it. Restrictions, reports, the admin audit trail and other users'
notifications keep pointing at the anonymised row.

**Revocation is inside the transaction**, unlike restriction revocation, which
runs after commit and may fail (see "Account restrictions"). That design works
because `AuthGuard` re-checks the restriction on every request. Nothing on the
request path checks `deleted_at`, so for deletion revocation is the
enforcement: it commits with the deletion or not at all.

**Afterwards** the account cannot log in or refresh (both lookups filter
`deleted_at IS NULL`, so even a matching credential would not authenticate),
and every previously issued access token is refused. `GET /users/:username`
returns `404` for the old username. The placeholder never reaches the lookup,
because its hyphens fail the route pattern (`400`), and the profile query also
filters `deleted_at IS NULL`. Activity telemetry never writes `last_seen_at` on
a deleted row. A second deletion with the old token is `401`; the `404` is only
reachable by two concurrent requests.

**Rendering retained content.** Posts and comments keep their `author_id`, so a
client resolving the author sees the `deleted_<id>` placeholder. The API
returns the placeholder unchanged and does not invent a display string. Clients
should recognise the `deleted_` prefix followed by a UUID and show "deleted
user". No registrable username has that shape.

**Restricted accounts cannot delete themselves.** The route is not
`@AllowRestricted()`, so a suspended or banned account gets `403` with the
restriction body. Otherwise deletion would be the ban-evasion path: delete,
re-register, start clean. Support answer: wait out the suspension, or appeal
the restriction; deletion is possible once it is lifted or has expired.

**Community creators must deal with their community first.** If the caller is
the `creator_id` of any community that is not deleted, the request is `409`:

```json
{
  "statusCode": 409,
  "message": "You created a community. Delete it or transfer its ownership before deleting your account.",
  "error": "Conflict"
}
```

Deleting the account would otherwise either delete the community (the cascade)
or leave it with an owner who can never act. A creator can now delete their
communities first with `DELETE /communities/:name` (a soft delete, see
[Editing and deleting a community](#editing-and-deleting-a-community)) and then
their account; the deleted community keeps `deleted_at`, and `deleted_by`
keeps referencing the anonymised account row. Ownership transfer is separate
work.

**The original username becomes available again.** The placeholder replaces
it in the row, so the old name is no longer in the unique index and a new
account may register it. Nothing links the new account to the old one: the old
account's content stays attributed to its id, which now shows the placeholder.
Clients and moderators must therefore identify accounts by id, never by
username. Reserving retired names would mean keeping a record of them (for
example a table of hashed usernames checked at registration); that is a
separate decision and not part of this change.

**No notification and no audit row.** The only account that could receive a
notification is the one being deleted. This is a user action, not an
administrative one, so it writes nothing to `admin_actions`, whose actions and
target types are platform-admin scoped; `users.deleted_at` is the record.

**Rate limit.** Besides the global buckets, deletion has its own daily buckets,
because a route that verifies a password is also a password-guessing oracle for
anyone holding an access token. See "API abuse controls and request bounds".

`DELETE` with a body rather than `POST /users/me/delete`: the resource is the
account itself, and the body only confirms the password. A client or proxy
that drops `DELETE` bodies gets `400` and deletes nothing, so the awkward case
fails safe.

## Data classification, errors, and logging

- **Public:** username, the user-authored profile fields `display_name` and
  `bio`, the account's join date (`created_at`), and user-authored post/comment
  content. Post and comment DTOs expose their public content identifiers and
  author IDs for attribution; those IDs are not credentials.
- **Private account data:** email is accepted for registration and login and
  is returned only to the account owner, by `GET /users/me`; it is not returned
  by public profile, auth, content, or list responses. Role is likewise
  returned only to its owner by that route. The signed-in auth-response user
  object contains only that account's ID and username. `last_seen_at` is
  private behavioral data, is not returned even by `GET /users/me`, and is only
  available through admin-authorized account detail and analytics.
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

## Outbound email

`EmailModule` (`src/email`) provides the delivery seam that flows such as
password reset need: the only safe channel for a reset token is the address on
file, never an HTTP response. Feature modules import `EmailModule` and inject
the abstract `EmailTransport`, which has a single
`send({ to, subject, text }): Promise<void>`. Messages are plain text only:
there is no HTML body, no attachments, and no templating. No route sends email
yet.

The transport is selected and validated when the application starts. An
invalid value, or a missing one in production, fails startup instead of
falling back:

| Variable | Rule | Default |
| --- | --- | --- |
| `EMAIL_TRANSPORT` | `logging` or `smtp`; anything else fails startup. An empty value counts as unset. | `logging` outside production; **none** in production, where an unset or empty value fails startup |
| `SMTP_HOST` | Required when `EMAIL_TRANSPORT=smtp`. | none |
| `SMTP_FROM` | Required when `EMAIL_TRANSPORT=smtp`; must be a bare email address (`noreply@example.com`, not `Name <…>`). | none |
| `SMTP_PORT` | Integer from 1 to 65535. | `465` when `SMTP_SECURE=true`, otherwise `587` |
| `SMTP_SECURE` | `true` (implicit TLS) or `false` (STARTTLS when the server offers it). | `false` |
| `SMTP_USER`, `SMTP_PASSWORD` | Optional, but must be set together. | unauthenticated |

**The logging transport refuses to start in production.**
`EMAIL_TRANSPORT=logging` with `NODE_ENV=production` fails startup, and so
does constructing `LoggingEmailTransport` directly. The logging transport
writes recipient, subject, and **body** through Nest's logger so flows can be
exercised locally without a provider. In production that would mean emails
that are never delivered and reset tokens written to the application log.
Outside production, treat the development log as containing email addresses
and tokens.

SMTP uses `nodemailer`, so no deployment is tied to one vendor. A
provider-specific transport can be added later behind the same interface.

**Failure policy.** `send` rejects on failure and does not retry: there is no
queue, backoff, or dead-letter store. SMTP failures reject with an
`EmailDeliveryError` that carries only the client's error code (for example
`EAUTH`), never the server's response text. A consumer **must not** surface
a send failure to its caller. It catches the rejection, logs it without the
message body, and returns its normal response. For a password-reset request,
"this address does not exist" and "sending failed" would otherwise become an
account-enumeration oracle.

**Logging rules.** A transport logs at most the recipient and subject, and
never the body. The SMTP transport logs nothing itself, and nodemailer's own
logger and debug output stay disabled, because they record the SMTP
conversation, including the body and the AUTH exchange. The logging transport
is the deliberate, development-only exception. Configuration errors name the
variable and its rule, never the configured value, so `SMTP_PASSWORD` cannot
reach a log line. No email address reaches an HTTP response:
`SafeApiExceptionFilter` reduces unexpected failures to a generic `500`.

Deliberately not included: email verification at registration, email-change
confirmation, notification digests, templating, queueing or retries, and
bounce handling. Each needs its own decision.

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
report returns `409`; after the earlier report is resolved or rejected,
another report may be filed. A duplicate is an active report by the same
reporter with the same target (`target_type`, `target_id`) and the same
evidence (`context_type`, `context_id`). Reporting the same account again with
different evidence, or none, is a new report. Keying on the target rather than
on `reported_user_id` means reports about two posts by one author can never
collide.
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

### Report targets

Since migration `016_generalise_report_targets`, a report names one
polymorphic target: `target_type` is `user`, `post`, `comment` or `community`,
and `target_id` is that row's ID. `POST /reports` writes only `user` targets,
with `target_id` equal to the reported account. Content and community
submissions are separate work; the schema is ready for them.

One table with one target column was chosen over one table per target kind,
which would make the admin queue `UNION` several near-identical tables to show
one ordered list. It was also chosen over nullable `post_id`, `comment_id` and
`community_id` columns, which leave no single column to group report
statistics by.

**No foreign key on `target_id`.** It is polymorphic, like `votes.target_id`,
`admin_actions.target_id` and `notifications.subject_id`. A report must outlive
the content it names, so the moderation decision stays auditable. Readers must
therefore not join the target to show a report, and must tolerate a target that
no longer exists.

**`reported_user_id` is kept, and is now nullable.** It names the account the
report concerns. Account filters (`reported_username`), the
`*_against_user` counts and restriction review all use it. Its foreign key is
`ON DELETE SET NULL` (it was `CASCADE`), so deleting an account no longer
deletes reports about it.

| `target_type` | `target_id` | `reported_user_id` | `target_author_id` |
| --- | --- | --- | --- |
| `user` | the account | the account | `NULL` |
| `post`, `comment` | the content | the content's author | the author at submission |
| `community` | the community | `NULL` | `NULL` |

`target_author_id` (`ON DELETE SET NULL`) records a content target's author at
submission time. A later change to `reported_user_id` therefore cannot silently
re-point the report. Deleting the author account clears both links, after
which only the target itself identifies the report's subject.

**`context_type` / `context_id` keep their meaning, narrowed.** They are
supporting evidence about a `user` target, never the target itself. The
existing check still requires both or neither, and `POST /reports` still
requires the content to be authored by the reported account. A content target
needs no separate evidence pointer.

**Self-reports.** `chk_user_reports_not_self` compares `reporter_id` with
`reported_user_id`. Because a content target stores its author in
`reported_user_id`, the same constraint refuses reporting your own post or
comment. For a community target `reported_user_id` is `NULL`, so the check
passes, which is correct.

`target_type` defaults to `'user'` only so the column could be added `NOT
NULL` to a populated table. Every writer sets it explicitly, and the default
should be dropped once content and community submissions exist.
`idx_user_reports_target (target_type, target_id, status)` serves the
duplicate check and per-target lookups.
`idx_user_reports_target_type_created (target_type, created_at)` serves
per-kind report statistics.

**The table is still named `user_reports`.** It now holds more than reports
about users. Renaming it would touch every service, test, fixture, index name
and the `user_restrictions.report_id` reference for no behavioural gain, so the
misnomer is kept on purpose.

Report creation has additional fixed-window limits of 20 per IP per hour and
10 per authenticated account per hour, in addition to the generic write
limits. Override them with positive-integer `API_REPORT_CREATE_IP_MAX`,
`API_REPORT_CREATE_IP_WINDOW_SECONDS`, `API_REPORT_CREATE_ACCOUNT_MAX`, and
`API_REPORT_CREATE_ACCOUNT_WINDOW_SECONDS`. Account counters use only the
validated bearer-token user ID. Exceeding a limit returns `429` and
`Retry-After`.

Account deletion (`DELETE /users/me`) has additional fixed-window limits of 10
per IP per day and 5 per authenticated account per day, because it verifies a
password and so doubles as a password-guessing oracle. Override them with
`API_ACCOUNT_DELETE_IP_MAX`, `API_ACCOUNT_DELETE_IP_WINDOW_SECONDS`,
`API_ACCOUNT_DELETE_ACCOUNT_MAX`, and
`API_ACCOUNT_DELETE_ACCOUNT_WINDOW_SECONDS`. Every attempt counts, including
wrong passwords and invalid bodies; requests refused by `AuthGuard` (no token,
or a restricted account) are refused before the limiter runs. Exceeding a
limit returns `429` and `Retry-After`.

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

### Community posts

#### `GET /communities/:name/posts`

Public, no bearer token. Lists one community's posts addressed by its public
name, like every other community sub-resource, so a client holding the name
needs one request instead of resolving the id first. Accepts `page` (`1` to
`10000`, default `1`), `limit` (`1` to `100`, default `20`) and `sort=new`
(the only value), and returns the same `{ "items", "page", "limit", "total",
"sort" }` envelope as `GET /posts`, with the same post type
(`PostListResponse`, `PostResponse`).

**Equivalent to `GET /posts?community_id=<its id>`, by construction.** The
route resolves the name to an id (`CommunitiesService.resolveListedId`) and
delegates to the one post listing path, `PostsService.findAll`, with that id.
There is no second copy of the query, so the two cannot drift apart: the same
items, order, `total` and fields, including the community's pinned posts
first (`ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id
DESC`; see [Pinning posts](#pinning-posts)). A change to the listing belongs in
`findAll`, never in the route. This is the form clients should prefer;
`GET /posts?community_id=` stays valid and is not deprecated.

| Status | When |
| --- | --- |
| `200` | The community exists; an empty community returns `items: []` and `total: 0` |
| `400` | A name `SafeRouteParamPipe('communityName')` rejects, an out-of-range `page` or `limit`, a `sort` other than `new`, or any unknown query property, including `community_id` (it would contradict the path) |
| `404` | Unknown, soft-deleted or suspended community |

**Exclusions.** Posts removed by moderation (`removed_at`) are omitted, as on
every post listing. A deleted or suspended community is `404`, not an empty
list, which would imply the community exists and is merely quiet; the name
lookup checks both `deleted_at` and `suspended_at`, and no listing query runs.
`GET /posts?community_id=` does not yet apply suspension (it is not enforced on
the other reads), which is the one case where the two routes differ.

**Plan.** The community filter is a `ref` lookup on
`idx_posts_community_created`. Because pins float first, the order needs a
filesort over that community's posts, exactly as on the filtered `GET /posts`;
`community-posts.mysql.spec.ts` records the measured plan, and the two-query
alternative is described under [Pins in listings](#pins-in-listings).

**Rate limits.** The global read buckets apply. This is expected to be the
hottest read in the product, so it is the first candidate for the explicit,
documented rate-limit override this README prescribes, never an exemption.

### Community suspension

**Nothing enforces suspension yet.** Migration `025_add_community_suspension`
adds the schema only: no endpoint sets or clears these columns and no read
excludes a suspended community, so a suspended community behaves exactly like
an active one. The endpoint that writes them must enforce them in the same
change and must not be merged without that enforcement.

`communities` gains three columns, all `NULL` for every existing community:

- `suspended_at`: when a platform administrator suspended the community;
  `suspended_at IS NULL` is the "not suspended" predicate.
- `suspended_by`: the administrator. `ON DELETE SET NULL`, so the suspension
  survives the removal of that account.
- `suspension_reason`: free text.

`chk_communities_suspension` rejects an actor or reason without a timestamp,
like `chk_user_restrictions_lift`, and `idx_communities_suspended_at` serves
the predicate.

**Suspension is indefinite by design.** There is no expiry column: a
community suspension lasts until an administrator restores it. A user
suspension needs an end date, but a timed community suspension has no clear
product meaning (the content is either acceptable or it is not), and adding
the column later is cheap.

**Suspension and deletion are separate facts.** `deleted_at` (migration
`022`) records the creator's own soft deletion; `suspended_at` records a
platform administrator's decision. They have different authority and
different remedies: the creator must never be able to clear a suspension, and
only an administrator could undo a deletion. A single status column would make
"who may change this" ambiguous, so they are two columns, and once suspension
is enforced every community read must check both predicates, alongside the
existing `deleted_at IS NULL` (see
[Editing and deleting a community](#editing-and-deleting-a-community)).

### Community statistics

`GET /communities/:name/stats` is **public**: these are the figures a
community advertises about itself, `GET /communities/:name` is already
public, and gating them would leave a prospective member unable to tell an
active community from a dead one. An unknown or deleted community returns
`404`, an invalid name `400`.

```json
{
  "member_count": 1280,
  "moderator_count": 3,
  "post_count": 4120,
  "comment_count": 19873,
  "created_at": "2026-01-14T09:12:00.000Z",
  "last_post_at": "2026-10-31T18:04:11.000Z",
  "posts_last_7_days": 86,
  "comments_last_7_days": 412
}
```

| Field                  | Definition                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `member_count`         | Subscription rows of live accounts. Equals the `total` of `GET /communities/:name/members`.                                |
| `moderator_count`      | Appointed moderators with live accounts, excluding the creator. Equals the `total` of `GET /communities/:name/moderators`. |
| `post_count`           | Posts in the community.                                                                                                    |
| `comment_count`        | Comments, including replies, on the community's posts.                                                                     |
| `created_at`           | When the community was created.                                                                                            |
| `last_post_at`         | The newest post's `created_at`; `null`, never omitted, when there are no posts.                                            |
| `posts_last_7_days`    | Posts with `created_at` in the last 7 days on the database clock.                                                          |
| `comments_last_7_days` | Comments with `created_at` in the last 7 days on the database clock.                                                       |

An empty community returns zeros and `last_post_at: null`, not `404`. The
response carries counts only: no ids, usernames or per-row data.

**The creator rule.** The creator is an implicit member but may have no
subscription row. `member_count` counts subscription rows, so the creator
counts only if subscribed; this keeps it equal to the member list instead of
off by one in a way nobody can explain. Likewise the creator is never counted
as a moderator, even if they appointed themselves. Both counts share their
SQL with the lists (`MEMBERS_JOIN`, `MEMBERS_WHERE`, `MODERATORS_FROM` in
`communities.service.ts`), so they cannot drift apart.

**No time range.** The route takes no query parameters at all; any parameter
returns `400`. `/admin/analytics` accepts arbitrary ranges because an
administrator investigating an incident needs them; on a public summary an
open range would turn the route into an arbitrary aggregation service over the
whole content history. The two windows are fixed at 7 days in the server and
computed in SQL from `UTC_TIMESTAMP()`, converted to the session time zone
(`CONVERT_TZ(DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY), '+00:00',
@@session.time_zone)`), never from the application clock. A configurable
window, if wanted, should be a small enum such as `7` or `30`, not a range.

**Forward requirement.** `post_count`, `comment_count` and the windows count
every stored row. Once posts and comments can be hidden by moderation
(`removed_at`, migration `017`, not yet read by any route), these counts must
exclude removed content in the same change, or they will silently include it.

**Query plan.** The community is resolved once by name; every aggregate is
bound to its id, and the name never reaches an aggregate query. Four
statements then run concurrently (`CommunityStatsService`), each served by an
index:

| Figures                                           | Statement                     | Index                                                                                   |
| ------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `member_count`                                    | subscriptions joined to users | `idx_community_subscriptions_community_created` (migration `024`), users by primary key |
| `moderator_count`                                 | moderators joined to users    | `community_moderators` primary key `(community_id, user_id)`                            |
| `post_count`, `last_post_at`, `posts_last_7_days` | one statement over posts      | `idx_posts_community_created`, index-only                                               |
| `comment_count`, `comments_last_7_days`           | posts joined to comments      | `idx_posts_community_created`, then `idx_comments_post_created` per post                |

`comments` has no community column, so the comment figures join through
the community's posts: one index range per post, bounded by the post count.
The escalation, if that join becomes a problem, is to denormalise
`comments.community_id`, making the count a single index read. That needs a
migration, a backfill and an insert-path change, so it is a separate issue to
take only after measuring; it is deliberately not done here.
`community-stats.mysql.spec.ts` asserts each plan on a seeded database.

**No caching.** Each statement is index-served, the global read bucket bounds
abuse, and a cache would need an invalidation story nothing else in this
project has. A short-TTL cache is the obvious next step if the route becomes
hot.

**Rate limits.** The route uses the global read buckets (120 `GET` per IP
per minute within the shared 300). It costs more than a row read, so it is the
first candidate for an explicit, documented rate-limit override if traffic
warrants one; it must never be exempted.

### Editing and deleting a community

Both routes require a bearer token and are **creator only**: the community's
`creator_id` may edit or delete it; its moderators, every other member and
platform administrators get `403`. An unknown community answers `404` before
any `403`, and an invalid name `400`. Moderators are refused because they
hold no powers beyond content actions, and the description and the existence
of the community are its public identity. The creator check lives in one place
(`CommunitiesService.getCommunityForRoleChange`), so widening it later is a
one-line change. Both routes count against the API write rate limits, and
each records one [community moderation log](#community-moderation-log) entry
in the same transaction as the change; a failure to write the entry rolls the
change back.

#### `PATCH /communities/:name`

Edits the community and answers `200` with the community DTO. The body
accepts only `description`: trimmed, at most 16,383 characters, plain text
without control characters. An empty or whitespace-only description is stored
as `NULL`; `null` itself is rejected (clearing is spelled `""`). An empty
body returns `400`, as does any other property:

- **`name` is not editable.** It is the route key of every community route,
  and `GET /communities/:name` is the community's published identity. Renaming
  would break every stored link to it, and there is no redirect mechanism.
- **`rules` are not editable here.** They are published as immutable
  versions through `PUT /communities/:name/rules`; accepting them in this body
  would recreate the second source of truth that dropping `communities.rules`
  removed.
- `creator_id`, `id`, `created_at` and any unknown property are rejected by
  the global `ValidationPipe`.

The edit records a `community_updated` entry whose metadata names the changed
fields (`{ "fields": "description" }`), never their old or new values.

#### `DELETE /communities/:name`

Deletes the community and answers `204`. The body must confirm the name:

```json
{ "name": "gardening" }
```

It must equal the route's community name exactly; a missing, mismatched or
differently cased name returns `400` and deletes nothing. This is the same
DELETE-with-a-body trade-off `DELETE /users/me` takes: a client or proxy that
drops the body gets a `400`, never a deletion. Deleting an already-deleted
community returns `404`. The deletion records a `community_deleted` entry.

**Deletion is a soft delete and destroys no content.** Migration
`022_add_community_deletion` adds `communities.deleted_at` and
`deleted_by`; the route sets them under a row lock and changes nothing else.
No post, comment, vote, subscription, moderator assignment, notification
preference, rule document, rule acceptance or moderation-log entry is
deleted. A hard delete was rejected because `ON DELETE CASCADE` would remove
every post and comment by every member in one call; deleting only empty
communities was rejected because it fails for exactly the communities whose
creators most want them gone, and "empty" is a moving target under
concurrency. `deleted_by` is `ON DELETE SET NULL`, so the record survives the
removal of the acting account.

**Every read excludes a deleted community.** A soft delete that one path
ignores would leave the community partly invisible and partly usable, so each
of these behaves as if the community did not exist:

| Path                                                                                   | Behaviour for a deleted community          |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| `GET /communities` (with or without `search`)                                          | omitted from `items` and `total`           |
| `GET /communities/:name`, `PATCH`, `DELETE`                                            | `404`                                      |
| `GET /subscriptions`                                                                   | omitted from `items` and `total`           |
| `GET /communities/:name/subscription`, `POST` and `DELETE .../subscribe`               | `404`                                      |
| `GET` and `PUT .../notification-preferences`                                           | `404`                                      |
| `POST` and `DELETE .../moderators`                                                     | `404`                                      |
| `GET` and `PUT .../rules`, `GET .../rules/versions`, `GET .../rules/versions/:version` | `404`                                      |
| `GET` and `POST .../rules/acceptance`                                                  | `404`                                      |
| `GET .../moderation-log`                                                               | `404`                                      |
| `GET .../moderators`, `GET .../members`                                                | `404`                                      |
| `GET .../stats`                                                                        | `404`                                      |
| `POST /posts` into it                                                                  | `404` (`Community not found`)              |
| `GET /posts` (with or without `community_id`)                                          | its posts omitted from `items` and `total` |
| `GET /posts/:id`, `PATCH /posts/:id`, `DELETE /posts/:id`                              | `404` for its posts                        |
| `GET` and `POST /posts/:postId/comments`                                               | `404` for its posts                        |
| `PATCH /comments/:id`, `DELETE /comments/:id`                                          | `404` for comments on its posts            |
| `POST /votes`; `PUT`, `DELETE` and `GET /posts/:id/vote` and `/comments/:id/vote`     | `404` for its posts and their comments     |

Content queries apply the shared `activeCommunitySql` predicate
(`src/common/community-visibility.ts`); community lookups add
`deleted_at IS NULL`. New reads of community-scoped data must do the same;
`src/common/community-visibility.spec.ts` lists every call site and fails if
one drops the exclusion. Platform administration (`/admin`) and the
notification inbox are deliberately not filtered.

A deleted community keeps its name: names are unique and never reused, so
creating a community with that name returns `409`.

**There is no restore route.** Deletion is irreversible through the API.
Administrative suspension and restoration of a community is separate work
with its own authorization, and a creator-facing undo would need its own
policy on who may resurrect a community and for how long. Because nothing is
destroyed, an operator can restore one by clearing `deleted_at` and
`deleted_by`.

**Deferred:** members are not notified that a community was deleted, and their
subscriptions stay in the table, invisible. Telling every member is a product
decision with its own fan-out concerns, and `notifications.type` would need a
new enum value.

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
A deletion by a moderator or creator notifies the author without naming who
removed it (see [Moderation notifications](#moderation-notifications)).
No edit, lock, ban, or other moderator-only operations are exposed by this API
yet; future such routes must enforce the same server-side, community-scoped
checks, and record what they do in the
[community moderation log](#community-moderation-log).

#### Moderator and member lists

Both lists name people by `username` and `display_name` only. Neither
returns a user id, email address, `last_seen_at`, password hash or
`users.role`: usernames are the public identifier everywhere else in this
API (moderator management, report submission, the audit logs), and ids are
internal. A deleted community answers `404` on both.

**`GET /communities/:name/moderators` is public.** Who moderates a community
is governance information: it answers "who removed my post" and "whom do I
ask", and `GET /communities/:name` is already public. A public list is also
a target list; that argument loses because an unnameable, unaccountable
moderator is worse, and moderator actions are already attributable through
the [community moderation log](#community-moderation-log) to the people who
can read it.

```json
{
  "creator": {
    "username": "gardener",
    "display_name": "Head Gardener",
    "role": "creator",
    "since": "2026-10-20T12:00:00.000Z"
  },
  "items": [
    {
      "username": "mod_mia",
      "display_name": null,
      "role": "moderator",
      "since": "2026-10-22T08:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

The response deviates from the plain envelope with a top-level `creator`.
The creator holds every moderator power, so omitting them would make the list
wrong in the way that matters most, but they come from `communities`, not
`community_moderators`. Making them the first item would shift every page by
one and need a `UNION ALL` and a corrected `total`; a separate object
sidesteps that. `creator` is therefore returned on every page, and `items`,
`total` and paging cover appointed moderators only, excluding the creator
even if they also appointed themselves. `since` is the appointment time for a
moderator and the community's creation time for the creator. Moderators are
ordered by appointment, oldest first (`created_at ASC, user_id ASC`).
`page` is 1-10000 and `limit` 1-100 (default 20); anything else is `400`.

**`GET /communities/:name/members` is for the community's moderators.** A
bearer token is required, and only the community creator and its moderators
may read it (the shared `canModerateCommunitySql` predicate). Anyone else,
including subscribed members and platform administrators, gets `403`; an
unknown community gets `404` before any `403`. A full roster is a bulk
extract of who belongs where, so it is a moderation tool, not a social
feature: making it public or members-only was rejected for the same reason
#15 minimised PII in responses. A public member count, if wanted, belongs on
a stats endpoint. `/admin` remains the administrators' surface.

| Parameter | Rules                                                                                       |
| --------- | ------------------------------------------------------------------------------------------- |
| `search`  | up to 50 characters, plain text; case-insensitive username substring; `%`, `_`, `=` literal |
| `page`    | integer 1-10000, default 1                                                                  |
| `limit`   | integer 1-100, default 20                                                                   |
| `sort`    | `new` (default, `created_at DESC, user_id DESC`) or `oldest` (`ASC, ASC`)                   |

Each item is `{ username, display_name, subscribed_at, is_moderator }`, using
the standard `{ items, page, limit, total }` envelope. `is_moderator` comes
from a join to `community_moderators`, so a moderator sees roles without a
second request. The list is of subscriptions: the creator, an implicit member,
appears only if they also subscribed.

**Deleted accounts are omitted from both lists**, rather than shown under
their placeholder username. A deleted account can no longer act, account
deletion already removes its subscriptions, and its moderator row is kept
only as history; the moderation log keeps its username snapshot.

**Index.** `community_subscriptions` has the primary key
`(user_id, community_id)`, which cannot serve a `community_id` filter.
Migration `024_add_community_subscriptions_community_index` adds
`idx_community_subscriptions_community_created (community_id, created_at,
user_id)`, so the member listing is read in index order without a filesort.
The community-post notification fan-out reads subscriptions in the same
direction and benefits too. The moderator list sorts the few rows of one
community in memory; `community_moderators`' primary key
`(community_id, user_id)` already narrows it to the community.

**Rate limits.** Both routes use the global read buckets. The member list is a
bulk read behind a moderator check, and `limit` is capped at 100, so no
dedicated bucket was added.

#### Community moderation log

`community_moderation_actions` (migration
`021_create_community_moderation_actions`) is the append-only record of what a
community's creator and moderators did in that community. Every row carries
its `community_id`. Entries survive a (soft) community deletion; only a hard
delete of the `communities` row, which no route performs, removes them.

**Why not `admin_actions`.** The [administrative audit
log](#administrative-action-audit-log) is platform-scoped: its action and
target enums describe platform decisions, it has no community column, and its
reader `GET /admin/audit-log` is administrator-only. A community moderator
could not read their own log there, and widening that route would expose
platform-wide enforcement to community moderators. The two logs are therefore
separate tables with separate readers.

**Actions.** The `action` enum is the complete set of planned community
moderator actions, including those whose endpoints do not exist yet:

| Action                                                    | Target          | Allowed metadata                   |
| --------------------------------------------------------- | --------------- | ---------------------------------- |
| `post_locked`, `post_unlocked`, `post_restored`           | `post`          | none                               |
| `post_pinned`, `post_unpinned`                            | `post`          | none                               |
| `post_removed`                                            | `post`          | `reason`                           |
| `comment_locked`, `comment_unlocked`, `comment_restored`  | `comment`       | none                               |
| `comment_removed`                                         | `comment`       | `reason`                           |
| `member_banned`                                           | `user`          | `username`, `reason`, `expires_at` |
| `member_removed`                                          | `user`          | `username`, `reason`               |
| `member_unbanned`, `moderator_added`, `moderator_removed` | `user`          | `username`                         |
| `rules_published`                                         | `rule_document` | `version`                          |
| `community_updated`                                       | `community`     | `fields`                           |
| `community_deleted`                                       | `community`     | none                               |

Declaring them up front means the endpoint issues that add locking, pinning,
removal, bans and member removal do not each need an `ALTER TABLE ... MODIFY
COLUMN` on the enum, which is the expensive kind of migration. The two
`community_*` actions and the `community` target were added afterwards by
migration `023_add_community_moderation_community_actions`, because `021` had
already been released; nothing had written to the table, so that rebuild was
immediate. `fields` is a comma-separated list of editable field names (today
only `description`), never their values.
`rules_published` covers the existing `PUT /communities/:name/rules`, and
`moderator_added`/`moderator_removed` the existing moderator routes; none of
them writes an entry yet.

**Writers are wired up by the endpoint issues.** `PATCH` and
`DELETE /communities/:name` were the first writers; `POST` and
`DELETE /posts/:id/pin` write `post_pinned` and `post_unpinned`, only when the
pin state actually changes. Each moderation endpoint calls `CommunityModerationLogService.record` as
part of its own work; the existing rules-publish and moderator-management
routes are retrofitted separately. `record` has the same two overloads as
`AuditLogService.record`: pass the caller's `PoolConnection` so the action and
its entry commit or roll back together, or pass only the entry to have the
service acquire and release its own connection. Passing an entry where a
connection is expected, or the reverse, throws `TypeError`. A failure to write
the entry must fail the action.

**Username snapshot, no joins.** The service resolves the actor's username
from `users` and stores it in `actor_username`; an actor that cannot be
resolved throws and writes nothing. `actor_id` is `ON DELETE SET NULL`, and
self-deletion anonymises the `users` row in place, so the snapshot is the only
reliable record of who acted. `target_id` is polymorphic with no foreign key,
because a removed post may later be hard-deleted and its entry must survive.
Readers must therefore never join `users` or the target to render a row.

**Metadata allowlist, no content.** `buildCommunityModerationMetadata` keeps
only the keys in the table above, drops every other key, throws on a
non-object or array value or an invalid allowlisted value, and stores `NULL`
when nothing survives. `reason` is moderator-written plain text of at most
2000 characters; `username` follows the username rules; `expires_at` is an
ISO 8601 timestamp; `version` is a positive integer. No action allows a post
or comment body, title or link: the log is a record of decisions, not a
content archive. The allowlist is the disclosure boundary of the read route,
which returns metadata exactly as stored.

##### `GET /communities/:name/moderation-log`

Bearer token required. Only the community creator and its moderators may read
the log, checked with the shared `canModerateCommunitySql` predicate. `401`
without a valid token, `404` for an unknown community (reported before any
`403`), `403` for anyone else, and `400` for an invalid name.

- **Not public.** The log names moderators next to the content they acted on,
  which would make it a target list. Notifications to an affected author
  already withhold the moderator's identity (see
  [Moderation notifications](#moderation-notifications)); a public log would
  undo that.
- **No platform administrators.** A platform administrator who neither
  created nor moderates the community gets `403`. `/admin` is a separate
  surface, and nothing requires administrators to read community logs.

| Parameter        | Rules                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `action`         | one of the actions above (shared `COMMUNITY_MODERATION_ACTIONS`)     |
| `actor_username` | 3–50 of `[A-Za-z0-9_]`; exact match on the stored username snapshot  |
| `target_type`    | `post`, `comment`, `user`, or `rule_document`                        |
| `from`, `to`     | ISO 8601; half-open UTC interval `from <= created_at < to`           |
| `page`           | integer 1–10000, default 1                                           |
| `limit`          | integer 1–100, default 20                                            |
| `sort`           | `new` (default, `created_at DESC, id DESC`) or `oldest` (`ASC, ASC`) |

Unknown parameters and invalid values return `400`. The `id` tiebreaker gives
a total order, so paging returns each entry exactly once.

```json
{
  "items": [
    {
      "id": "entry-id",
      "action": "post_removed",
      "actor_username": "moderator_name",
      "target_type": "post",
      "target_id": "post-id",
      "metadata": { "reason": "Spam" },
      "created_at": "2026-10-28T10:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

`actor_username` is never `null`, even for a deleted actor. Items do not
include `actor_id`. An entry whose target no longer exists is still listed
with its raw `target_id`.

Every index starts with `community_id` except the target index, which serves
lookups of one target's history:

| Filter present            | Index                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| none, or only `from`/`to` | `idx_community_moderation_actions_community` (`community_id, created_at, id`)                            |
| `actor_username`          | `idx_community_moderation_actions_actor` (`community_id, actor_username, created_at`)                    |
| `action`                  | `idx_community_moderation_actions_action` (`community_id, action, created_at`)                           |
| `target_type`             | the community index; `idx_community_moderation_actions_target` is `(target_type, target_id, created_at)` |

The actor index is on the username snapshot rather than `actor_id`, because
that is what the filter matches; `admin_actions` needed migration `006` to
correct the same mismatch. MySQL adds its own index on `actor_id` for the
foreign key. Reads of the log are not themselves logged.

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

**Acceptance is enforced.** Joining, posting, commenting and voting require
the current version to be accepted; see
[Rule acceptance and participation](#rule-acceptance-and-participation). Both
routes stay reachable throughout, including for a member refused there.

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

**Acceptance neither requires nor creates membership.** Joining is conditional
on having accepted, so acceptance must be reachable by a non-member or joining
becomes impossible. The intended client flow is two
deliberate calls: accept the rules, then `POST /communities/:name/subscribe`.

**Only real changes require reacceptance.** Publishing a new version makes
`acceptance_required` true again for everyone, while earlier acceptance rows
stay on record. A publish whose items hash equal to the current document
creates no version (see [Rules API](#rules-api)), so it never forces
reacceptance.

Accepting writes no `admin_actions` entry: the audit log is for
platform-administrative actions, and the acceptance row is itself the durable,
timestamped record.

#### Rule acceptance and participation

A user who has not accepted a community's current rules version cannot
participate in it. **Enforcement is server-side**: every gated path below is
reachable with a bearer token and `curl`, so a client-side check is a prompt
for the user, never the enforcement.

The check is one method,
`CommunityRuleAcceptanceService.assertAcceptedOrThrow(userId, communityId,
connection?)`, which decides from `getState()`. It is the only place the
decision is made; no participation path restates the SQL or the rule. A
`CanActivate` guard was rejected because each path derives its community
differently (route parameter, body field, the post, or the comment's post), and
two of them resolve the target inside a transaction that must also hold the
check. A guard would repeat those lookups outside that transaction.

**Gated paths.** Each checks after its existence checks and before writing.

| Route                               | Community comes from                             | Checked                                                   |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `POST /communities/:name/subscribe` | the route parameter                              | on the pool, before the insert                            |
| `POST /posts`                       | `community_id` in the body                       | inside the post's transaction                             |
| `POST /posts/:postId/comments`      | the post (top-level comments and replies alike)  | inside the comment's transaction                          |
| `POST /votes`, `PUT /posts/:id/vote`, `PUT /comments/:id/vote` | the post, or for a comment, `comments` → `posts` | inside the vote's transaction, after the target is locked |

**Exempt paths, each deliberately:**

- **`POST /reports` is never gated.** Reporting is a safety mechanism. A user
  who has not accepted a community's rules, perhaps because of what they just
  saw there, must still be able to report it. Gating it would make the rules a
  shield for the content they exist to prohibit. This is the most important
  exemption; `reports.e2e-spec.ts` asserts the check is never consulted.
- **All reads**: `GET /communities`, `GET /communities/:name`, `GET /posts`,
  `GET /posts/:id`, `GET /posts/:postId/comments`, `GET /users/:username`, the
  [Rules API](#rules-api) and the [Rule acceptance API](#rule-acceptance-api).
  A user must be able to read the community and its rules before deciding to
  accept, and gating reads would hide public content.
- **`DELETE /posts/:id` and `DELETE /comments/:id`.** Removing content is not
  participation. An author who declines new rules can still withdraw what they
  wrote under the old ones, and a moderator can still remove content.
- **`PATCH /posts/:id` and `PATCH /comments/:id`.** Editing existing content is
  not new participation: an author who declines new rules can still correct
  what they wrote (see [Editing posts and comments](#editing-posts-and-comments)).
- **`DELETE /communities/:name/subscribe`.** Leaving must never require
  acceptance, or a user who declines the rules is trapped in the community.
- **`DELETE /posts/:id/vote` and `DELETE /comments/:id/vote`.** Withdrawing a
  vote removes participation; gating it would leave a user who declines new
  rules with votes they cannot retract (see [Votes](#votes)). The matching
  `PUT` routes are gated.
- **`POST /auth/*`** is outside any community, and **`POST /communities`** has
  no community yet (its creator is exempt once it exists).
- **`POST`/`DELETE /communities/:name/moderators`** are creator-only, and the
  creator is exempt, so a check there could never refuse anyone. It is
  deliberately not added.

Unit and e2e tests assert that these exempt paths never call the check, so a
later change cannot "complete" the coverage by gating them.

**Who is exempt within a gated path.** The community creator is never refused:
they author the rules, and refusing them between publishing and accepting
helps no one. Community moderators are **not** exempt; they are members bound
by the rules like anyone else, and their deletion powers are unaffected because
deletion is not gated. Platform administrators are not exempt either: the
`/admin` surface is separate, and gated paths are member actions.

**The refusal** is `403` with this body, following `AuthGuard`'s structured
`403` for a restriction:

```json
{
  "reason": "community_rules_not_accepted",
  "community": "gardening",
  "current_version": 2
}
```

It is `403`, not `409`: the request is well formed and the user authenticated,
but not permitted. The body lets a client prompt for acceptance instead of
showing an opaque refusal, and contains only the community name and current
version, both already public through `GET /communities/:name/rules`. It never
contains a user id, document id or rule text. Nothing is written on a refusal,
and the post, comment and vote transactions roll back and release their
connection.

**Existing members when the rules change** keep their `community_subscriptions`
row; membership is never revoked. Their participation is refused until they
accept the new version, and the acceptance routes are reachable throughout.
This is the intended behaviour of the version-aware `getState()`, not a side
effect. A no-op republish creates no version (see [Rules API](#rules-api)), so
it refuses no one. Members grandfathered onto the backfilled `version = 1` by
migration `012` (see [Rule acceptances](#rule-acceptances)) have a real
acceptance row and are not refused, so enabling enforcement does not lock out
the existing user base.

**Communities without published rules are unaffected.** `getState()` reports
`acceptanceRequired = false` when no document exists, so every gated path
succeeds with no acceptance row. Each of the four paths has a test for this,
because a regression here would block every write in the product.

**404 before 403.** An unknown community, post, parent comment or vote target
returns `404` before the rules are consulted, matching
`CommunitiesService.getCommunityForRoleChange`, so the error code never says
whether a community the caller cannot act in exists.

**No caching.** Each gated write costs one indexed lookup, served by the
documents' `unique_community_rule_version (community_id, version)` key and the
acceptances' primary key, plus one primary-key read of the community only when
acceptance is required (for the creator exemption and the refusal body). Writes are already rate-limited far below
where that matters. A cached decision would let a user participate under rules
they have not accepted for the cache's lifetime, which is exactly what this
enforcement exists to prevent.

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
to keep pagination stable. **With `community_id`, that community's pinned
posts come first** (see [Pinning posts](#pinning-posts)); the unfiltered
listing never floats pins. Posts removed by moderation (`removed_at` set,
migration 017) and posts in a deleted community are never listed. An empty
page is returned with HTTP `200`.

`GET /posts?community_id=…` is kept and is not deprecated: it is published
API, still serves clients that hold an id, and its unfiltered form is the only
listing across all communities. To list one community, clients should prefer
the name-based [`GET /communities/:name/posts`](#get-communitiesnameposts),
which returns the same result.

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
to the post's comments. To correct a post without losing them, the author
uses `PATCH /posts/:id` (see
[Editing posts and comments](#editing-posts-and-comments)); moderators may
delete a post but never edit it.

Post responses use this DTO:

```json
{
  "id": "post-id",
  "title": "A post",
  "content": "Post body",
  "type": "text",
  "author_id": "user-id",
  "community_id": "community-id",
  "created_at": "2026-10-22T08:00:00.000Z",
  "pinned_at": null,
  "pinned_by": null,
  "edited_at": null,
  "score": 3
}
```

`pinned_at` and `pinned_by` are present on every post response and are `null`
on a post that is not pinned. `edited_at` is `null` until the author's first
effective edit (see [Editing posts and comments](#editing-posts-and-comments)).
`score` is the sum of the post's votes, `0` without votes (see
[Scores on content](#scores-on-content)).

### Editing posts and comments

`PATCH /posts/:id` and `PATCH /comments/:id` let an author correct their own
content in place. Without them the only fix for a typo was to delete and
repost, which discards everything that cascades from the row: a post's
comments (`comments.post_id ON DELETE CASCADE`), its votes, its id and its
`created_at`, and the reply chain beneath a comment. An edit is an `UPDATE` of
the same row, so all of these survive (`content-editing.mysql.spec.ts` asserts
it against a real database).

| Route | Body | Success |
| --- | --- | --- |
| `PATCH /posts/:id` | `UpdatePostDto`: `title` and/or `content`, at least one | `200`, `PostResponse` |
| `PATCH /comments/:id` | `UpdateCommentDto`: `content`, required | `200`, the flat `CommentReplyResponse` |

Both require a bearer token. The fields carry exactly the validators of
`CreatePostDto` and `CreateCommentDto` (bounds, trimming, `PlainTextConstraint`).
An absent post field is left unchanged; an empty `PATCH /posts/:id` body is
`400` (`PostUpdateHasFieldConstraint`, so the validation pipe answers, as for
`PATCH /users/me`). A comment edit returns the flat comment with `reply_count`
and `score` rather than a thread node, whose empty `replies` array would
misrepresent a comment that has replies.

**Immutable fields.** Only `title` and `content` of a post, and `content` of a
comment, are editable. `type`, `community_id`, `author_id`, `created_at`,
`parent_id`, `post_id` and any other property are rejected with `400` by the
global `ValidationPipe` (`forbidNonWhitelisted`) and nothing is written.
`parent_id` in particular can never change: re-parenting would move a subtree
and could create a cycle.

**Content is validated against the stored type.** `CreatePostDto` requires an
HTTP(S) URL with a host, no credentials, no backslash and no control
characters for `link` and `media` posts, deciding by the `type` in the body. An
edit has no `type` in its body, so that rule (`isValidPostContent`, the one copy
shared with `CreatePostDto`) runs in `PostsService.update` against the type
loaded with the locked row, and still answers `400`. Without this a link post's
content could be edited to arbitrary text, past the URL rules. Requiring `type`
in the body as an assertion was considered and rejected: it adds a field whose
only purpose is to be checked. A title-only edit of a link post is not
URL-checked; a text post accepts any plain text.

**Author only.** Only the author may edit: a community moderator, the community
creator and anyone else get `403` ("Only the author may edit this post" or
"comment"). This deliberately differs from `DELETE /posts/:id` and
`DELETE /comments/:id`, which moderators and the creator may use. Moderators
hold content-removal powers, not content-authorship powers: rewriting someone's
words under their name is impersonation, and moderators already have removal
(and locking) for content they object to. Platform administrators get no
bypass either; `/admin` has no content-editing route.

**Flow.** Each edit runs in a transaction. It reads the row `FOR UPDATE` (a
comment `FOR UPDATE OF comments`, joined to its post), then checks in this
order:

| Status | When |
| --- | --- |
| `404` | Unknown id, or the community is deleted or suspended (`listedCommunitySql`) |
| `403` | The caller is not the author |
| `409` | The post or comment was removed by moderation (`removed_at`); for a comment, also when its post was removed, or the comment or its post is locked |
| `400` | Post content that is not valid for the stored type |

Only then does it write, commit, roll back on any error, and release the
connection in `finally`. A non-author therefore learns nothing about the
content's moderation state. A removed post or comment is refused so that an
author cannot rewrite content a moderator removed before any restoration.

**Locks: a locked post stays editable by its author; comments on it do not.**
A lock closes the discussion; it does not freeze the original text, so the
author of a locked post may still correct it. A comment is part of the
discussion, so a comment on a locked post, or a locked comment, is `409`. Only
the comment's own lock and its post's lock are consulted. A comment's
`locked_at` is meant to lock its subtree, but locks on ancestor comments are not
consulted, because the lock endpoint that defines subtree locking does not
exist yet.

**`edited_at` and the no-op rule.** A successful edit sets `edited_at` from the
database clock (`UTC_TIMESTAMP()`), on every effective edit. The trimmed
submitted values are compared with the stored ones and only fields that differ
are written. If nothing differs, nothing is written: the route answers `200`
with the unchanged content and `edited_at` keeps its previous value (`null` if
never edited), because marking unchanged content as edited would be
misleading. `edited_at` is on every post and comment response
(`PostResponse`, `CommentResponse`, `CommentReplyResponse`,
`UserCommentResponse`), so clients can mark edited content.

**Not gated on rule acceptance.** Editing existing content is not new
participation, for the same reason `DELETE /posts/:id` is ungated: a user who
declines a community's new rules must still be able to correct what they
already wrote. They cannot post or comment anew until they accept.

**Deliberately absent:**

- **No edit window.** Many platforms allow edits for only a few minutes.
  Nothing in the product requires one, and `edited_at` already shows that an
  edit happened. If one is wanted, it should be a configured value read with
  `readPositiveInteger`, like `COMMUNITY_PINNED_POSTS_MAX`.
- **No edit history.** Only the latest version is stored; `edited_at` says that
  an edit happened, not what changed. Revisions would need a new table and a
  product decision about who may read them. Out of scope.
- **No notification.** The author is the actor; nobody else is told.

**Rate limiting: a known gap, not closed here.** Edits fall under the global
write buckets only (`api:write:ip`, 60 per IP, and `api:write:account`, 120 per
account, per minute). The `api:content:create:*` buckets in
`AuthRateLimitService` key on `POST /posts` and `POST /posts/:postId/comments`
by method and path, so they do not cover `PATCH`. An author can therefore
rewrite content up to 60 times a minute per IP. Reusing the create buckets was
rejected, because their cooldown would block a quick correction right after
posting. No dedicated edit bucket is added in this change. If abuse appears, an
`api:content:edit:*` bucket keyed on `PATCH /posts/:id` and
`PATCH /comments/:id` is the follow-up, as a documented per-route override.

### Pinning posts

Moderators can keep announcements, welcome threads, megathreads and event
posts at the top of their community's listing. Migration
`026_add_post_pinning` stores the pin on the post itself: `pinned_at` (when)
and `pinned_by` (who), the same nullable-timestamp-plus-actor shape as the
lock and removal columns. A separate pins table was rejected: a post belongs
to exactly one community, so being pinned in several places is meaningless.

#### `POST /posts/:id/pin`

Bearer token required, no body. Pins the post and returns `200` with the post
DTO, `pinned_at` taken from the database clock (`UTC_TIMESTAMP()`) and
`pinned_by` from the token.

**Only the post's community creator and that community's moderators may pin.**
The post's author may not, unless they also moderate the community. This is
the opposite of the rule for deleting (and, later, editing) a post, where the
author may act: pinning lifts one post above everyone else's in a shared feed,
which is a moderation power, not an authorship one. A moderator of a
different community is refused like any other member.

| Status | When |
| --- | --- |
| `200` | Pinned, or already pinned (unchanged) |
| `400` | Malformed post ID |
| `401` | Missing, invalid or expired token |
| `403` | The caller does not create or moderate the post's community, or the account is restricted |
| `404` | Unknown post, or a post in a deleted community |
| `409` | The community is at its pin cap, or the post was removed by a moderator |

**Idempotent, and `pinned_at` is never refreshed.** Pinning a pinned post
returns `200` with the post unchanged and writes no log entry. `pinned_at` is
also the order of the pinned set, so refreshing it would silently move a post
to the top of the pins. The `UPDATE` is guarded by `AND pinned_at IS NULL`;
`affectedRows = 0` is treated as "already pinned".

**Cap.** A community may have at most `COMMUNITY_PINNED_POSTS_MAX` pinned posts
at once (default `5`, read once at startup through `readPositiveInteger`).
Pinning beyond it returns `409` naming the limit and pins nothing; unpin one
first. Without a cap, pinning every post would turn emphasis into feed
control. The count is taken inside the pin transaction after locking the
community row (`SELECT … FROM communities … FOR UPDATE`), and is itself a
locking read (`FOR SHARE`), so two concurrent pins at the boundary are
serialised and exactly one succeeds. A repeat pin of an already-pinned post
is not counted and still returns `200` at the cap.

The whole request runs in one transaction on one connection: the post row is
read `FOR UPDATE` together with `canModerateCommunitySql` (authorisation is
decided in the service through `isSqlTrue`), then the cap is checked, the row
updated and the `post_pinned` entry written to the [community moderation
log](#community-moderation-log). A failure to write the entry rolls the pin
back. The connection is released on every path.

#### `DELETE /posts/:id/pin`

Bearer token required. Same authorisation and the same locking read as
pinning. Clears both columns and returns `204`, writing a `post_unpinned`
entry in the same transaction. Unpinning a post that is not pinned also
returns `204` and writes nothing, matching the idempotent
`DELETE /communities/:name/subscribe`. An unknown post is `404`. The pin is
modelled as a sub-resource the post either has or does not (`POST`/`DELETE` on
`/pin`, like `/subscribe`), not as a separate `/unpin` action.

#### Pins in listings

**Behaviour change:** `GET /posts?community_id=…` now orders by

```sql
ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id DESC
```

so the community's pinned posts come first, most recently pinned first, then
every other post newest first. The order is total, so pagination stays stable
even when a page boundary falls inside the pinned set. `total` counts pinned
and unpinned posts alike.

The unfiltered `GET /posts` keeps exactly its previous order
(`created_at DESC, id DESC`) and does not float pins: one community's
announcement has no claim on the global feed. `sort` still accepts only
`new`; pinning is not a sort option.

**Filesort trade-off.** The leading `(pinned_at IS NULL)` term cannot be read
from an index, so a single community's listing is a filesort over that
community's posts (found through a `community_id` index) instead of the
index-ordered read `idx_posts_community_created` gave before. A materially
better plan needs two queries: the community's pins (at most the cap, via
`idx_posts_community_pinned`), then the page of unpinned posts on
`idx_posts_community_created` with the number of pins subtracted from the
offset. The single query ships for now because it is simpler and the sort is
bounded by one community's size; revisit if that plan becomes a problem.
`post-pinning.mysql.spec.ts` asserts the actual plan (a `ref` lookup on a
`community_id` index, `Using filesort`) so the decision is measured, not
assumed, and a plan change fails the suite.

#### Schema

| Column | Meaning |
| --- | --- |
| `pinned_at` | When the post was pinned; `NULL` when not pinned. Orders the pinned set |
| `pinned_by` | Who pinned it. `ON DELETE SET NULL`, so a pin survives deletion of the moderator's account |

`chk_posts_pin` forbids `pinned_by` without `pinned_at`. **Readers must
tolerate a `NULL` `pinned_by` on a pinned post**; the API returns it as
`pinned_by: null`. `idx_posts_community_pinned (community_id, pinned_at)`
serves the cap's per-community count and the "pinned posts of this community"
read. The migration is not safely re-runnable after partial application; its
header lists what to inspect before completing it by hand.

**Rate limiting.** The global write buckets apply (60 per IP and 120 per
account per minute). Pinning is a rare moderator action and has no dedicated
bucket.

**No notification.** The post's author is not told that their post was
pinned: a pin is not an action against the author, and `notifications.type`
is an `ENUM` whose new value would need its own migration. A
`post_pinned` notification is a possible follow-up.

### Post content state

Migration `017_add_post_and_comment_content_state` adds edit, lock and
moderative-removal state to `posts`. `PATCH /posts/:id` writes `edited_at` and
honours `locked_at` and `removed_at` (see
[Editing posts and comments](#editing-posts-and-comments)), and listings omit
removed posts. Nothing writes `locked_at` or `removed_at` yet, and
`DELETE /posts/:id` is still a hard delete. The lock and removal endpoints are
separate work.

| Column | Meaning when set |
| --- | --- |
| `edited_at` | When the author last edited the post |
| `locked_at`, `locked_by` | When and by whom the post was locked against new comments |
| `removed_at`, `removed_by`, `removal_reason` | When, by whom and why a moderator removed the post, keeping its content for restoration |

Each state is a nullable timestamp, not a boolean: `NULL` means "not in this
state" and a value also records when. This follows `user_restrictions.lifted_at`,
`notifications.read_at` and `user_reports.reviewed_at`. Every existing row is
unedited, unlocked and present, and once removal exists, `removed_at IS NULL`
is the visibility predicate. `removal_reason` is optional in the schema;
whether removing requires a reason is the removal endpoint's decision.

`chk_posts_lock` and `chk_posts_removal` forbid an actor or reason without its
timestamp. `locked_by` and `removed_by` are `ON DELETE SET NULL`, so a lock or
removal survives deletion of the moderator's account. **Readers must tolerate
a `NULL` actor on a locked or removed post.**

There is no `edited_by`: only the author may edit, so the editor is always
`author_id`, and a column would suggest that moderators can edit.

`idx_posts_removed_at` lets the optimiser estimate the selectivity of a
`removed_at` filter. It serves `removed_at IS NOT NULL` (the few removed
posts) and covering lookups such as counts. A full listing where nearly every
row is visible still reads the table rather than this index. The composite
listing indexes that pair the filter with the sort order are separate work.

## Comments

`GET /posts/:postId/comments` is public and returns
`{ "post_id", "comments" }`. Comments are nested recursively through `replies`;
each comment contains its `id`, `post_id`, `author_id`, `parent_id`, `content`,
`created_at`, `score` (see [Scores on content](#scores-on-content)) and
`replies`. Roots and sibling replies use chronological order
(`created_at` ascending, then `id` ascending), making the thread order stable.
An unknown post returns `404`.

The tree is built in memory from one unpaginated read, so it is capped at 500
comments (`MAX_COMMENTS_PER_THREAD`). A larger thread returns `413` with:

```text
Comment threads are limited to 500 comments; page through GET /posts/:postId/comments/top-level and GET /comments/:id/replies instead
```

Before the paginated routes below existed, that `413` was the only answer: a
thread that grew past 500 comments became permanently unreadable through the
API, with no way to read its first page, its newest replies or anything else.
The ceiling stays: raising it only moves the cliff, and removing it lets one
request build an unbounded payload in memory. The tree route is otherwise
unchanged, so no existing client breaks; the `413` now names the way out.

### Paginated comments

Two public routes page a thread one level at a time, and together reach every
comment of a thread of any size: page the post's root comments, then page the
replies of each comment whose `reply_count` is above `0`, recursively.

| Route | Lists | `404` when |
| --- | --- | --- |
| `GET /posts/:postId/comments/top-level` | The post's root comments (`parent_id IS NULL`) | The post is unknown or its community is deleted |
| `GET /comments/:id/replies` | The direct replies of comment `:id` (`parent_id = :id`), one level only | The comment is unknown or its post's community is deleted |

Both take the same query (`ListCommentRepliesDto`): `page` (1-10,000, default
`1`), `limit` (1-100, default `20`) and `sort` (`oldest` or `new`, default
`oldest`). Out-of-range values and unknown query properties return `400`, as
does a malformed id. Both return the standard envelope
`{ "items", "page", "limit", "total", "sort" }`; a comment without replies, or
a post without root comments, returns `200` with `items: []` and `total: 0`.
Each item is:

```json
{
  "id": "comment-id",
  "post_id": "post-id",
  "parent_id": "parent-comment-id",
  "author_id": "user-id",
  "content": "Text",
  "created_at": "2026-10-22T08:00:00.000Z",
  "edited_at": null,
  "reply_count": 3,
  "score": 5
}
```

**Items are flat and must never nest.** The tree route's `CommentDto` is a
recursive node; reusing it here would put each item's whole subtree into the
page and reintroduce exactly the unbounded read these routes exist to remove: a
paginated endpoint whose items carry subtrees is not bounded. Items therefore
use a separate flat type (`CommentReplyResponse` in OpenAPI, distinct from the
recursive `CommentResponse`) with a `reply_count` that tells a client whether
to recurse. Do not add a `replies` array, or a `depth` parameter, to them.

**Why the tree route was not paginated instead.** Adding `page`/`limit` to
`GET /posts/:postId/comments` was considered and rejected. Its contract is a
nested tree, and paginating a tree has no well-defined meaning: a page boundary
can fall inside a subtree, so a page is either cut mid-discussion or unbounded
again. Two flat routes are honest; one half-paginated tree is not.

**`oldest` is the default, unlike every other listing.** Every other collection
in this API defaults to `new`. A reply chain reads in the order it was written,
and the tree route already orders `created_at` ascending, so the paginated
routes and the tree agree by default. `sort=new` reverses both keys.

**Ordering and plans.** `oldest` orders `created_at ASC, id ASC`, `new` orders
`created_at DESC, id DESC`; `id` is the tiebreaker, so paging returns each
comment exactly once in either direction. Replies are a ref on
`idx_comments_parent_created (parent_id, created_at, id)` and roots a ref on
`idx_comments_post_created (post_id, created_at, id)` with `parent_id IS NULL`
filtered from it, both read in index order (backwards for `new`) without a
filesort (`comment-listings.mysql.spec.ts` asserts the plans). On a table
where the post's comments outnumber all root comments site-wide, the optimiser
may prefer `idx_comments_parent_created` for the roots instead; that plan is
also index-ordered without a filesort.

**`reply_count`** counts an item's visible direct replies. It comes from one
`COUNT(*) … WHERE parent_id IN (…) GROUP BY parent_id` over the page's ids, not
a correlated subquery per row, so a page is three statements whatever its size
(plus the parent or post lookup). It is not a stored counter column: that would
need a migration, a backfill and a change to the insert and delete paths, and
the grouped count, a range on `idx_comments_parent_created` over at most 100
ids, has not been measured to need it.

**Removal.** Both routes omit comments with `removed_at` set (migration `017`),
from `items`, from `total` and from `reply_count`. A removed comment's own
replies **remain readable** through `GET /comments/:id/replies` with the
removed comment's id: removing one comment hides that comment, not the
discussion beneath it, so the route does not 404 a removed parent. Its replies
are not reachable by crawling from the roots, since the removed comment is not
listed; a client reaches them with an id it already holds (a link, a
notification). The tree route does not read `removed_at` yet.

**Rate limiting.** The global read buckets apply; there is no dedicated bucket.
The routes replace one expensive unbounded read with several cheap bounded
ones, which is a net improvement.

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

`PATCH /comments/:id` lets the author, and only the author, edit the content
in place, keeping the reply chain; moderators may delete a comment but never
edit it. See [Editing posts and comments](#editing-posts-and-comments).

### Comment content state

Migration `017` adds the same six columns and the same rules to `comments` as
to posts (see [Post content state](#post-content-state)): `edited_at`,
`locked_at`/`locked_by`, and `removed_at`/`removed_by`/`removal_reason`. They
are nullable timestamps with optional actors, coherent through
`chk_comments_lock` and `chk_comments_removal`, and the actors are
`ON DELETE SET NULL`, so readers must tolerate a `NULL` actor. There is no
`edited_by`, because only the author edits. `idx_comments_removed_at` indexes
the removal filter. The paginated comment routes read `removed_at` (see
[Paginated comments](#paginated-comments)), and `PATCH /comments/:id` writes
`edited_at` and refuses removed or locked comments (see
[Editing posts and comments](#editing-posts-and-comments)). Nothing writes
`locked_at` or `removed_at` yet, and the thread, comment creation and
`DELETE /comments/:id` do not honour them.

A comment's `locked_at` is meant to lock that comment's subtree, not the whole
post. The schema supports either reading; the lock endpoint will define it.

## Votes

A vote is addressed by the post or comment it is on, like every other action on
those resources. Each target has three routes, all requiring a bearer token and
all tagged `votes` in OpenAPI:

| Route | Does | Success | Rule gate |
| --- | --- | --- | --- |
| `PUT /posts/:id/vote`, `PUT /comments/:id/vote` | Sets the caller's vote to `value` | `200`, the vote and its score | Yes |
| `DELETE /posts/:id/vote`, `DELETE /comments/:id/vote` | Withdraws the caller's vote | `200`, `{ "score" }` | **No** |
| `GET /posts/:id/vote`, `GET /comments/:id/vote` | Reads the caller's vote | `200`, `{ "value", "score" }` | No |

On every route a malformed id is `400`, an unknown post or comment, or one in a
deleted community, is `404`, and a missing token is `401`. The voter is always
the authenticated user. Every route goes through `VotesService`, so the target
lookup, the lock, the rule gate, the upsert and the score are each written
once. A comment's community, for the rule gate, is its post's
(comments → posts), as `lockTarget` resolves it.

### Casting a vote: `PUT`

The body is `CastVoteDto`: `{ "value": 1 }` or `{ "value": -1 }`. A missing or
other value, or any other property (`target_type`, `user_id`, …), returns
`400`. The response is the existing `VoteResponse`:

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

**Why `PUT`.** `unique_user_target (user_id, target_type, target_id)` allows
at most one vote per user and target, even under concurrent requests, so a
vote is a singleton sub-resource whose entire state is `value`. `PUT` sets that
state and is idempotent: repeating a request leaves one row and returns the
same score, and a different `value` updates the row in place
(`INSERT … ON DUPLICATE KEY UPDATE`). `POST` would suggest a collection of
votes. The target row is locked for the transaction, so the returned score
includes this vote.

Voting is participation: a caller who has not accepted the community's current
rules gets `403` with the payload described under rule acceptance
(`reason: "community_rules_not_accepted"`), checked after the `404` for an
unknown target.

### Withdrawing a vote: `DELETE`

Deletes the caller's vote in the same transaction shape as a vote: the target
is locked first, so the returned score reflects the deletion. It answers `200`
with the new score, `{ "score": 2 }`, because that is what the client has to
redraw and cannot otherwise get; a `204` would cost a second request.

It is **idempotent**: without a vote, nothing is deleted and the current score
is returned with `200`, not `404`, as `DELETE /communities/:name/subscribe`
does for a user who is not subscribed.

**Withdrawal is not gated on rule acceptance**, and must not be. Withdrawing a
vote removes participation rather than adding it. Gating it would trap a user
who declines new community rules with votes they can no longer retract: the
same reasoning that keeps `DELETE /posts/:id`, `DELETE /comments/:id` and
`DELETE /communities/:name/subscribe` ungated. `PUT` is gated and `DELETE` is
not; this asymmetry is deliberate.

### Reading your vote: `GET`

Returns the caller's own vote and the target's score:

```json
{ "value": -1, "score": 4 }
```

`value` is `null` when the caller has not voted: `200` with `null`, not `404`,
because "have I voted?" has a valid negative answer (the same reasoning as
`GET /communities/:name/subscription`). The lookup is bound to the
authenticated user, so it never reveals another account's vote, which is why the
route needs a token. It is a plain read: no transaction, no lock, no rule gate.
The own-vote lookup is a `const` read of `unique_user_target`, the score a `ref`
on `idx_votes_target` read from the index alone.

### Scores on content

Every post and comment response carries `score`, the sum of all vote values,
`0` for unvoted content: `PostResponse` (`GET /posts`, `GET /posts/:id`,
`GET /communities/:name/posts`, `GET /users/:username/posts`, pin, create), the
thread's `CommentResponse`, the flat `CommentReplyResponse` and
`UserCommentResponse`. Score is public; it belongs on the content, and the
authenticated `GET …/vote` exists only for the caller's own `value`.

Scores are loaded per page, never per row: after the page is selected, one
statement aggregates the page's ids
(`loadVoteScores` in `src/votes/vote-scores.ts`):

```sql
SELECT target_id, SUM(value) AS score FROM votes
WHERE target_type = ? AND target_id IN (?, …) GROUP BY target_id
```

This is the per-page join of the scores onto the listing, done as a second
statement bounded to at most one page of ids (500 for a thread), rather than a
join against an unbounded derived table. `idx_votes_target (target_type,
target_id, value)` serves it as a covering range scan (`Using index`, no
temporary table, no filesort). A newly created post or comment has score `0`
and issues no vote query.

**A stored score was considered and not taken.** A denormalised `posts.score`
(and `comments.score`) counter would need a migration, a backfill and a write
on every vote, withdrawal and cascade delete. The covering index makes the
aggregate cheap, so the counter stays the named escalation if measurement shows
the per-page aggregate is too slow. `vote-routes.mysql.spec.ts` asserts the
plans so that a regression fails a test rather than going unnoticed.

### `POST /votes` (deprecated)

`POST /votes` with `{ "target_type", "target_id", "value" }` still works
exactly as before: it answers `201` with the same `VoteResponse` and runs the
same `VotesService.vote` path, so it and `PUT /posts/:id/vote` produce the
same row and score. It is published API, so it is marked `deprecated` in the
OpenAPI document only, and will be removed in a future change. New clients
should use the per-target routes, which can be documented, authorised and
rate-limited per resource.

### Rate limiting

The global API buckets apply: `PUT` and `DELETE` count against the write
buckets (`api:write:ip`, 60 per IP, and `api:write:account`, 120 per account
per minute), `GET` against the read buckets. Voting is the highest-frequency
legitimate write in the product. If abuse appears, a dedicated vote bucket is
the candidate, added as a documented per-route override, never an exemption.

## Notifications

Notifications are stored in the `notifications` table (migration
`010_create_notifications`) and written only through `NotificationsService`
(see [Writing notifications](#writing-notifications)), and read through the
routes in [Inbox API](#inbox-api), which also mark notifications read or
unread and dismiss them. Comments, replies and new posts produce
notifications (see [Content notifications](#content-notifications)), and so do
moderation decisions (see
[Moderation notifications](#moderation-notifications)). Each row belongs
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

### Content notifications

Three content events write notifications:

| Event                                       | Producer                 | Recipient                                                       | `type`           | Subject         | Metadata                                  |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------- | ---------------- | --------------- | ----------------------------------------- |
| A top-level comment (`parent_id` is `null`) | `CommentsService.create` | the post's author                                               | `post_comment`   | the new comment | `post_id`, `post_title`, `excerpt`        |
| A reply (`parent_id` is set)                | `CommentsService.create` | the parent comment's author                                     | `comment_reply`  | the new comment | `post_id`, `parent_comment_id`, `excerpt` |
| A new post                                  | `PostsService.create`    | every eligible member of the post's community except its author | `community_post` | the new post    | `post_title`                              |

`excerpt` is the start of the comment body and `post_title` the post's title,
both capped by the metadata allowlist. Because the subject is the new comment,
two comments on one post are two notifications, while a retried write of the
same comment hits the unique key and stays one. Commenting on your own post
and replying to your own comment write nothing: `NotificationsService` drops
self-notifications, so the producers do not check for them.

**Exactly one notification per comment.** A top-level comment notifies only
the post author; a reply notifies only the parent comment's author, never the
post author as well, even when the two are different people. The reply is
addressed to the person replied to, and the post author already sees the
thread through the post. Notifying both was considered and rejected: it either
notifies one person twice for one event (when the post author wrote the parent
comment) or needs a recipient-deduplication step whose answer to "which type
wins?" is arbitrary. This is deliberate, not an omission.

**Community fan-out honours the preference contract.** `community_post`
recipients are selected with the
[community new-post recipient contract](#community-notification-preferences)
above, which `NotificationsService.recordCommunityPost` wraps unchanged and
extends only with `s.user_id <> ?` to exclude the author. A muted member
(`new_posts = FALSE`) receives nothing, a member without a preference row
receives one, and a non-member never does, whatever their preference row says.
The fan-out is a single `INSERT ... SELECT` over that query, ending in
`ON DUPLICATE KEY UPDATE id = id`, so the number of round trips does not grow
with the member count and a retry is safe. It uses MySQL's `UUID()` for row
ids rather than reading the recipient list into the application for
`recordMany`, which would cost one statement per 500 members. `UUID()` yields
the same 36-character form as `randomUUID()` and fits `VARCHAR(36)`, though
as a version 1 rather than a version 4 UUID; nothing reads meaning into an id,
and inbox ownership is enforced by `recipient_id`, not by unguessable ids.

**Fan-out ceiling.** One post in a large community becomes one row per member
inside the post's transaction. `PostsService.create` therefore counts the
eligible recipients first, and when there are more than
`NOTIFICATION_FANOUT_MAX` (default `5000`), it writes no `community_post`
notifications, logs a warning with the community id and the count, and still
creates the post. A post must never fail because its community is popular.
Skipping is deliberate where truncating is not: notifying an arbitrary subset
would leave nobody able to tell who was told. `NOTIFICATION_FANOUT_MAX` is read
through `readPositiveInteger`, so it accepts an integer from 1 through 86400;
that helper bound is kept on purpose, because a synchronous fan-out larger
than that inside one request's transaction is exactly what the ceiling
exists to prevent. The proper fix for large communities is a queue or a
batched background fan-out, which is deliberately out of scope for now.

**Written inside the content action's transaction.** `CommentsService.create`
and `PostsService.create` acquire a connection, run their reads, the insert,
and the notification write in one transaction, commit on success, roll back on
error, and release the connection in `finally` on every path, including the
ceiling skip. Following the [transaction policy](#writing-notifications), a
failed notification write therefore rolls back the comment or post, and the
request fails with `500`. Their routes keep their status codes, response
bodies, and validation otherwise unchanged.

A notification whose post or comment is later deleted still renders in the
inbox from its metadata snapshot. **Votes never produce notifications**, as
recorded above, and there is no real-time delivery: clients poll
`GET /notifications/unread-count`.

### Moderation notifications

**A moderation notification tells the affected user what happened to them,
never who decided it or why.** `actor_id` is always `NULL` for these types
(the `NotificationEntry` type and `assertNotificationEntry()` reject an
actor), and the metadata allowlist holds nothing a non-admin may not already
see under [Account restrictions](#account-restrictions-suspensions-and-bans)
and [Data classification](#data-classification-errors-and-logging). Do not add
a field to these types unless the README already permits a non-admin to see
it.

| Event                                                      | Producer                                        | Recipient            | `type`                | Subject                     | Metadata                                               |
| ---------------------------------------------------------- | ----------------------------------------------- | -------------------- | --------------------- | --------------------------- | ------------------------------------------------------ |
| A report reaches `resolved` or `rejected`                  | `AdminReportsService.updateStatus`              | the reporter         | `report_resolved`     | the report                  | `status` only                                          |
| A suspension or ban is applied                             | `AdminRestrictionsService.apply`                | the restricted user  | `restriction_applied` | the restriction             | `restriction_type`, plus `expires_at` for a suspension |
| A restriction is lifted                                    | `AdminRestrictionsService.lift`                 | the user             | `restriction_lifted`  | the restriction             | `restriction_type` only                                |
| A community moderator or creator deletes someone's content | `PostsService.remove`, `CommentsService.remove` | the content's author | `content_removed`     | the deleted post or comment | `post_title` for a post, `excerpt` for a comment       |

- **Reports.** `{ status }` answers "was my report acted on?" and nothing more.
  The notification never carries `resolution` (it describes what happened to
  another person's account), `resolution_note` (an internal note),
  `reviewed_by` or the reviewer's username, or the reported user. A move to
  `under_review` writes nothing: it is a queue state, not an outcome. A repeated
  or otherwise refused transition is a `409` and writes nothing. A report whose
  reporter account was deleted (`reporter_id` is `NULL`) writes nothing and
  still succeeds.
- **Restrictions.** The metadata is exactly what `AuthGuard`'s `403` already
  returns to the restricted user: the type and, for a suspension, `expires_at`.
  Never `reason`, `lift_reason`, `created_by`, `lifted_by` or `report_id`. The
  inbox read routes are `@AllowRestricted()` (see [Inbox API](#inbox-api)), so
  a restricted user can read `restriction_applied` while the restriction is
  active. Sessions are revoked when it is applied and a restricted account
  cannot sign in, so in practice it is read with a token that survived a
  failed revocation, or after the restriction ends. It is written either way: it becomes readable after a lift,
  and the inbox should not have a gap where the most consequential event
  belongs. `restriction_lifted` is the one the user can always read.
- **Content removal.** Only a removal by a community moderator or the
  community creator notifies; an author deleting their own content writes
  nothing, even if they also moderate the community. Producers check this
  themselves, because moderation types have no actor for central
  self-suppression to compare. There is no removal reason, because the API has
  no field for one. Only the author of the removed post or comment is told:
  comments deleted with it by cascade do not notify their authors. The content
  is gone by the time the inbox is read, so the row renders entirely from the
  snapshot; this is why `subject_id` has no foreign key. Platform
  administrators have no content-removal route, so they are not a case here.

**Deletion decides authorisation in the service.** `PostsService.remove` and
`CommentsService.remove` used to be one conditional `DELETE` whose `WHERE`
clause admitted the author or a moderator, which could not say which of the
two had acted. They now lock and read the row in a transaction
(`SELECT ... FOR UPDATE`, or `FOR UPDATE OF comments` so the joined post is
not locked), together with whether the actor created or moderates its
community (`canModerateCommunitySql` in `src/common/community-moderation.ts`).
They then decide in code, delete by id, and notify the author when the actor is
not the author. The routes behave exactly as before: `204` for the author or a
moderator or creator of that community, `403` for anyone else (including a
moderator of a different community), and `404` for missing content.

**Written inside the moderation transaction.** Every producer above records
the notification on the connection it already holds, next to its
`admin_actions` audit entry where there is one. A failed notification write
therefore rolls back the report transition, restriction, lift or deletion.
This is deliberately the opposite of `AuthService.logoutAll`, which
`AdminRestrictionsService.apply` runs after the commit and allows to fail,
because the restriction row is an independent enforcement backstop for
revocation. A lost notification has no backstop. Do not move these writes after
the commit without revisiting the [transaction policy](#writing-notifications).

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

**Restricted accounts can read their inbox but not change it.** The three read
routes are marked `@AllowRestricted()`, so an account under an active
suspension or ban can reach them. Otherwise the user who most needs "your
account was suspended, here is the type and expiry" would be the one user who
cannot read it. This discloses nothing new: `AuthGuard`'s own `403` already
returns the restriction type and expiry, and moderation notifications carry no
moderator identity. The state-changing routes below are deliberately not
marked: a restricted account needs to read why it is restricted, not to write,
and keeping every write blocked keeps the restriction's meaning simple. They
answer `403` with the restriction payload. A controller test lists which
handlers are in each group, so a new route must be placed in one on purpose.

#### Changing notification state

All three routes require a bearer token (`401` without one), take the owner
only from it, and use the same ownership rule as the reads. Each runs one
statement scoped by `recipient_id`, and a row that does not exist or belongs
to someone else is `404` either way. **No second query is issued** to tell the
two apart, so a response can never confirm that another user's notification
exists. An invalid ID returns `400`.

| Route                          | Body                | Success                           | Errors                         |
| ------------------------------ | ------------------- | --------------------------------- | ------------------------------ |
| `PATCH /notifications/:id`     | `{ "read": true }`  | `200` with the notification       | `400`, `401`, `403`, `404`     |
| `POST /notifications/read-all` | none                | `200` with `{ "updated": 12 }`    | `400`, `401`, `403`            |
| `DELETE /notifications/:id`    | none                | `204`, no body                    | `400`, `401`, `403`, `404`     |

`PATCH /notifications/:id` takes `{ "read": true }` or `{ "read": false }` and
returns the notification in the listing's item shape. `read` is a required
boolean; a missing or non-boolean value, a client-supplied `read_at`, or any
other property returns `400` and writes nothing. `read: true` runs
`UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE
id = ? AND recipient_id = ?`, so `read_at` comes from the database clock and a
repeat keeps the original time: **marking read is idempotent and never
refreshes the timestamp**, because when the user read it is the only thing the
column records. `read: false` sets `read_at` to `NULL`, and the notification
counts as unread again. Both statements match the row whether or not it
changes, because mysql2's default `FOUND_ROWS` flag reports a matched row as
affected; `affectedRows = 0` therefore means only "not yours or missing". Do
not disable that flag on the pool.

One `PATCH` with a boolean replaces separate `.../read` and `.../unread` routes:
the operation sets one field on a resource the caller owns, which a partial
update expresses exactly, and one handler keeps one ownership check instead of
two that can drift. Marking unread exists so that a one-click "read" can be
undone; it adds no state the column cannot already express.

`POST /notifications/read-all` runs `UPDATE notifications SET read_at =
UTC_TIMESTAMP() WHERE recipient_id = ? AND read_at IS NULL` and returns
`{ "updated": n }`, the number of rows that were unread. The `read_at IS NULL`
predicate keeps existing timestamps and makes a repeat return
`{ "updated": 0 }`, as does an empty inbox. It is a `POST` because it is an
action over a collection the caller does not otherwise address, like
`POST /auth/logout-all`. **It takes no filters**: any body or query parameter,
including `type` or `community_id`, returns `400`. A filtered bulk write would
be an unbounded update whose scope the client decides, and nothing in the
product needs one; a filtered variant would need its own route and bounds.

The statement's row count is unbounded: a long-lived account could hold tens of
thousands of unread rows, all locked by one statement. No mitigation is
applied, because the update is driven by `idx_notifications_recipient_unread`,
scoped to one recipient, and contends with nothing (only the owner writes
their own rows). If retention or chunking is ever introduced, this is the
statement to revisit.

`DELETE /notifications/:id` dismisses one notification and returns `204` with
no body; it then disappears from the listing and the unread count, and a
second delete returns `404`. **Dismissal is a hard delete**, not a
`dismissed_at` flag. A notification is a derived convenience record; the
durable history lives in `admin_actions` for moderation decisions,
`user_reports` for reports, and the content tables for posts and replies. A
soft delete would add a second predicate to every inbox query and the unread
count for no reader. The consequence is accepted: a user who deletes "your
account was suspended" cannot get it back, while `user_restrictions` remains
the record of truth and the admin surface still shows it.

**There is no bulk delete.** Nothing needs one, and deleting everything is a
destructive unbounded write that deserves a deliberate decision rather than
arriving as a convenience.

**Indexes.** Each query keeps a prefix of one of migration `010`'s indexes:
the listing uses `idx_notifications_recipient_created`, the unread filter and
unread count use `idx_notifications_recipient_unread`, and the type filter
uses `idx_notifications_recipient_type`, and `read-all` uses
`idx_notifications_recipient_unread`; the single-row writes locate their row
by primary key. The `community_id` filter, and `read` combined with `type`,
are served by the recipient prefix and filtered from there. `src/notifications/notification-inbox.mysql.spec.ts` checks the plans
with `EXPLAIN` against migration `010`; it runs with
`MYSQL_INTEGRATION_TEST=true` and `MYSQL_*` credentials that may create a
scratch database.

**Rate limits.** The read routes use the global read buckets (120 reads and
300 requests per IP per minute), and the state-changing routes the write
buckets (60 per IP and 120 per account per minute, comfortably above a human
rate while bounding a runaway client). None is exempt and none has a dedicated
bucket. Polling `unread-count` every 30 seconds costs two requests a minute; if
a dashboard pattern later exceeds a bucket, add an explicit documented override
rather than a bypass.

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
