import { customAlphabet } from 'nanoid';

// URL-safe, collision-resistant ids for application-assigned query ids etc.
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const generate = customAlphabet(alphabet, 21);

/** Generate a short id with an optional prefix (e.g. `q_…`, `nb_…`). */
export function newId(prefix = ''): string {
  return prefix ? `${prefix}${generate()}` : generate();
}
