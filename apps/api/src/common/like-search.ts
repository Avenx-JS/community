export function escapeLikeSearch(value: string): string {
  return value.replace(/[=%_]/g, '=$&');
}
