import { z } from 'zod';

/** ISO 8601 timestamp with timezone offset, used for all `*At` fields. */
export const isoTimestamp = z.iso.datetime({ offset: true });

/** A non-empty identifier string. */
export const id = z.string().min(1);
