/**
 * Minimal class-name joiner. Accepts strings, falsy values and is order-stable.
 * Kept dependency-free; Tailwind utility conflicts are avoided by construction
 * (we don't conditionally swap the same property in opposite directions).
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter((v): v is string | number => Boolean(v)).join(' ');
}
