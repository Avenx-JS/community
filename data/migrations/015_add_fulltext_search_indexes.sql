-- FULLTEXT indexes for word search over posts, comments and communities.
-- Nothing queries them yet; the search endpoint is a separate change and must
-- query with MATCH (...) AGAINST (? IN BOOLEAN MODE) using exactly the column
-- lists below. Users are deliberately not indexed: usernames are single tokens
-- matched by prefix through the existing UNIQUE index on users.username.
--
-- COST. The first FULLTEXT index on an InnoDB table adds the hidden
-- FTS_DOC_ID column, which rebuilds the whole table. Each statement below is
-- the first FULLTEXT index on its table, so on a populated posts or comments
-- table expect a slow, I/O-heavy rebuild rather than a normal CREATE INDEX.
-- MySQL 8.0 runs it as online DDL with ALGORITHM=INPLACE, but adding a
-- FULLTEXT index does not permit concurrent writes (LOCK=SHARED at best), so
-- schedule it in a maintenance window on a production database.
--
-- Not safely re-runnable after partial application; inspect which of the
-- three indexes exist before completing this migration manually:
--   SELECT table_name, index_name FROM information_schema.statistics
--   WHERE table_schema = DATABASE() AND index_type = 'FULLTEXT';
CREATE FULLTEXT INDEX ft_posts_title_content ON posts (title, content);

CREATE FULLTEXT INDEX ft_comments_content ON comments (content);

CREATE FULLTEXT INDEX ft_communities_name_description
  ON communities (name, description);
