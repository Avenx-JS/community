## What this changes

<!-- Briefly describe your changes. -->

## Related issue

Closes #

## How was this verified?

<!-- List the commands you actually ran and their results. -->

## Checklist

- [ ] `npm test` passes (in `apps/api`)
- [ ] `npm run test:e2e` passes (in `apps/api`)
- [ ] `npm run lint` passes, and only the files I changed were formatted
- [ ] Tests added or updated where appropriate
- [ ] New or changed routes are documented with the OpenAPI decorators
- [ ] `apps/api/README.md` updated where behavior changed
- [ ] If the schema changed: a new migration, `data/community.sql` and `enum-history.ts` updated, and the MySQL specs run (`MYSQL_INTEGRATION_TEST=true`), as described in [CONTRIBUTING.md](../CONTRIBUTING.md#database-changes)
- [ ] No secrets, tokens, email addresses or moderator identities are exposed in responses or logs
