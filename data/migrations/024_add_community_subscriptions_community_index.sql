-- Serves reads of community_subscriptions from the community side: the
-- GET /communities/:name/members listing and the community_post notification
-- fan-out. The primary key (user_id, community_id) leads with user_id, so it
-- cannot serve a community_id filter. The shape is (filter, created_at,
-- user_id): user_id is the pagination tiebreaker, so ORDER BY created_at,
-- user_id is read in index order without a filesort.
-- Do not drop the implicit single-column foreign-key index on community_id:
-- whether MySQL accepts a composite as a foreign key's supporting index
-- depends on creation order and version, and dropping it can fail the ALTER
-- or leave the constraint without its index.
-- No behaviour change; only query plans change.
-- Not safely re-runnable after success; the statement fails if the index
-- already exists. Inspect the index before re-running manually.
-- On a populated community_subscriptions table this locks or copies; consider
-- running it as online DDL (ALGORITHM=INPLACE, LOCK=NONE).
CREATE INDEX idx_community_subscriptions_community_created
  ON community_subscriptions (community_id, created_at, user_id);
