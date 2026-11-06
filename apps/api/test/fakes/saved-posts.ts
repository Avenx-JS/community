export interface FakeSave {
  user_id: string;
  post_id: string;
}

// Answers the per-page saved-flag lookup of loadSavedFlags
// (src/posts/saved-flags.ts), or returns null for any other statement. Like
// the real query it is bound to the viewer, so it reports only their saves.
export function answerSavedFlags(
  sql: string,
  values: unknown[],
  saves: readonly FakeSave[] = [],
): [unknown[], unknown[]] | null {
  if (!sql.startsWith('SELECT post_id FROM saved_posts WHERE user_id = ?')) {
    return null;
  }
  const [userId, ...ids] = values as string[];
  return [
    saves
      .filter((save) => save.user_id === userId && ids.includes(save.post_id))
      .map((save) => ({ post_id: save.post_id })),
    [],
  ];
}
