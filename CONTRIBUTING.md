# Contributing to the Avenx.js Community Platform

First of all, thank you for your interest in contributing!

This repository is the official Avenx.js community platform: communities,
posts, comments, moderation and platform administration. Every contribution,
whether it's code, documentation, bug reports, or ideas, helps improve it.

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security
issues are never reported in public; see [SECURITY.md](SECURITY.md).

## Before You Start

Before creating a contribution, please:

* Search existing issues and pull requests to avoid duplicates.
* Open an issue for larger changes or new features before implementing them.
* Ensure your proposal fits the platform's scope and its moderation model:
  platform administrators and community moderators have different powers,
  and a change must keep them apart.

## Repository Layout

| Path | What it is |
| --- | --- |
| `apps/api` | The REST API: NestJS 11, MySQL 8 (`mysql2`), optional Redis/BullMQ |
| `apps/web` | The web client: Angular 21 |
| `data/community.sql` | The full-install database snapshot |
| `data/migrations/` | Schema migrations, `NNN_snake_case_description.sql` |
| `deploy/` | Deployment configuration (nginx) |
| `docker-compose.yml` | MySQL and Redis for local development |

[`apps/api/README.md`](apps/api/README.md) is the authoritative description
of the API: every route, its rules, and the reasoning behind them. Read the
section for the area you change before you change it.

## Local Development Workflow

1. **Configure the environment.** Copy `sample.env` to `.env` in the
   repository root and choose your own passwords. The API reads its settings
   from the process environment; export the variables in your shell (or use
   your IDE's run configuration) before starting it.

2. **Start MySQL (and Redis, if you want it):**

   ```bash
   docker compose up -d db redis
   ```

   Redis is optional in development (`REDIS_ENABLED=false` uses in-memory
   fallbacks).

3. **Create the schema.** For a new database, run `data/community.sql`, then
   apply any pending migrations from `apps/api`:

   ```bash
   npm run migrate
   ```

4. **Install and run the API:**

   ```bash
   cd apps/api
   npm install
   npm run start:dev
   ```

   Outside production the OpenAPI document and Swagger UI are served by
   default (`SWAGGER_ENABLED` overrides it).

5. **Install and run the web client:**

   ```bash
   cd apps/web
   npm install
   npm start
   ```

## Tests

All commands run from `apps/api`.

| Command | What it runs |
| --- | --- |
| `npm test` | Unit specs (`src/**/*.spec.ts`). The `*.mysql.spec.ts` suites are skipped by default. |
| `npm run test:e2e` | End-to-end specs (`test/*.e2e-spec.ts`) against the real Nest app and in-memory database fakes |
| `MYSQL_INTEGRATION_TEST=true npm test -- src/database` | The MySQL integration specs, against a real server |
| `npm run lint` | ESLint with Prettier |

The MySQL integration specs create and drop scratch databases, so they need
`MYSQL_*` credentials with those rights. Never point them at a database you
care about.

Every change should come with tests:

* A service or controller change: unit specs next to the code.
* A new or changed route: an e2e spec, including its error answers.
* A migration: a migration spec (`src/database/*-migration.spec.ts`) and a
  MySQL spec that applies it through the real runner.
* A bug fix: a regression test that fails without the fix.

### Writing tests that pass on every platform

Contributors work on Linux, macOS and Windows. Git checks files out with CRLF
on Windows, and some files in this repository have CRLF line endings, so a
regex that reads a checked-out file must accept `\r\n`, and an edit must keep
a file's existing line endings.

## Code Style

* Run `npm run lint` before you open a pull request.
* **Format only the files you changed.** Run `npx eslint --fix <files>` on
  them (its Prettier rule keeps each file's line endings) instead of running
  Prettier over a folder, which rewrites unrelated files and their line
  endings.
* Comments explain *why*, not *what*. The existing code is a good guide.

## Database Changes

Schema changes follow the rules in
[Database schema and migrations](apps/api/README.md#database-schema-and-migrations):

1. Add a new migration with the next free number. Once released, a migration
   is never edited: correct it with a new one.
2. One logical change per migration, and a header comment that states whether
   it is safe to re-run after partial application (MySQL DDL is not
   transactional).
3. **Enums are append-only.** New members go at the end, in the same order as
   the TypeScript constants that mirror them (for example `ADMIN_ACTIONS`,
   `NOTIFICATION_TYPES`). Record the members in
   `apps/api/src/database/enum-history.ts`.
4. Update `data/community.sql` in the same change, folding enum members into
   the `CREATE TABLE` statements and recording the migration in
   `schema_migrations`, so new and upgraded installations stay identical.

## API Changes

* Document every route with the OpenAPI decorators (`@ApiOperation`,
  `@ApiAuthenticated`, `@ApiErrorResponses`, typed response classes).
  `src/common/swagger.spec.ts` fails for an undocumented route.
* Update `apps/api/README.md` when behavior, a rule, or an error answer
  changes.
* Never return or log secrets, tokens, password hashes or email addresses,
  and never reveal who moderated: moderation notifications carry no actor.
* Audit and notification metadata are allowlists. A new field goes through
  `buildAuditMetadata` or `buildNotificationMetadata`, never around them.

## Pull Requests

* Keep a pull request to one topic.
* Link the issue it resolves.
* Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md),
  including the commands you actually ran.
* Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/)
  style used in this repository, for example `feat(modmail): ...` or
  `fix: ...`.

Maintainers review pull requests according to the
[Maintainer Guidelines](MAINTAINER_GUIDE.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) of this repository.
