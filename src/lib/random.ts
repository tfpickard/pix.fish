export function pickOne<T>(items: T[] | null | undefined): T | null {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)]!;
}
