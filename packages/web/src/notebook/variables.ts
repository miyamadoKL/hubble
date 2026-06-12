// Variable detection + substitution (design.md §4, §5 "変数"; Hue-compatible).
//
// Hue's variable substitution lets a query carry `${name}` placeholders that the
// user fills in before running. We support the four Hue forms:
//
//   ${name}                       — bare placeholder, no default
//   ${name=default}               — a single default value
//   ${name=opt1,opt2,…}           — a select of plain options (value === label)
//   ${name=label(value),…}        — a select of labelled options
//
// Detection is *comment-aware*: a `${…}` inside a `--` or `/* */` comment is NOT
// a variable. We get this for free from the ANTLR lexer, which groups comments
// onto the HIDDEN channel — we drop any candidate whose `$` sits in a comment.
//
// A `${…}` inside a *string literal* (e.g. `WHERE s = '${status=O,F,P}'`) IS a
// variable: Hue substitutes the text before the SQL is parsed, so the quotes
// belong to the resulting SQL, not to the placeholder. We therefore keep string
// interiors in scope and rely on the strict `${name…}` grammar (a valid
// identifier name) to reject things that merely look like a placeholder.
//
// Everything here is pure and synchronous (no Monaco/DOM), so it is exercised
// directly by vitest.

import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import type { Variable, VariableMeta, VariableType } from '@hubble/contracts';
import { SqlBaseLexer } from '../trino-lang/generated/SqlBaseLexer.js';

/** A single placeholder occurrence parsed from the source. */
export interface DetectedVariable {
  name: string;
  /** The default value (from `${n=default}`) or '' when none was given. */
  defaultValue: string;
  /** Parsed select options when the form was `${n=a,b}` / `${n=label(value)}`. */
  options?: { label: string; value: string }[];
  /** True when the form carried a `=` (so an empty string is an explicit default). */
  hasDefault: boolean;
}

// Matches `${ ... }` where the body has no nested braces. The body is captured
// raw and parsed by `parseBody` so we keep one place for the `name=value` rules.
const PLACEHOLDER = /\$\{([^{}]*)\}/g;

/** A [start, end) span in the source that detection must ignore. */
interface Span {
  start: number;
  end: number;
}

/**
 * Spans of all comments in `sql`. A `${…}` whose `$` falls inside any of these
 * is trivia, not a variable. (String literals are intentionally NOT excluded —
 * see the module header.)
 */
function exclusionSpans(sql: string): Span[] {
  const lexer = new SqlBaseLexer(CharStream.fromString(sql));
  lexer.removeErrorListeners();
  const stream = new CommonTokenStream(lexer);
  stream.fill();
  const spans: Span[] = [];
  for (const t of stream.getTokens()) {
    if (t.type === Token.EOF) continue;
    if (t.type === SqlBaseLexer.SIMPLE_COMMENT || t.type === SqlBaseLexer.BRACKETED_COMMENT) {
      // token.stop is the index of the last char (inclusive); make end exclusive.
      spans.push({ start: t.start, end: t.stop + 1 });
    }
  }
  return spans;
}

function inAnySpan(offset: number, spans: Span[]): boolean {
  for (const s of spans) {
    if (offset >= s.start && offset < s.end) return true;
  }
  return false;
}

/** A valid variable name: identifier-ish, matching Hue's tolerant rules. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a placeholder body (`name`, `name=default`, `name=a,b`,
 * `name=label(value),…`) into a DetectedVariable. Returns undefined for an
 * empty/invalid name.
 */
function parseBody(body: string): DetectedVariable | undefined {
  const eq = body.indexOf('=');
  if (eq === -1) {
    const name = body.trim();
    if (!NAME_RE.test(name)) return undefined;
    return { name, defaultValue: '', hasDefault: false };
  }
  const name = body.slice(0, eq).trim();
  if (!NAME_RE.test(name)) return undefined;
  const rhs = body.slice(eq + 1);

  // Split the RHS on top-level commas (commas inside `label(value)` parens are
  // part of nothing here — labels don't contain commas in Hue's grammar, but we
  // still split only outside parens to be safe).
  const parts = splitTopLevel(rhs);
  if (parts.length > 1 || /\(.*\)/.test(rhs)) {
    const options = parts.map(parseOption).filter((o): o is { label: string; value: string } => !!o);
    if (options.length > 0) {
      return { name, defaultValue: options[0]!.value, hasDefault: true, options };
    }
  }
  // Single plain default.
  return { name, defaultValue: rhs.trim(), hasDefault: true };
}

/** Split on commas that are not nested inside `( … )`. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Parse one option token: `label(value)` → {label,value}; `x` → {label:x,value:x}. */
function parseOption(token: string): { label: string; value: string } | undefined {
  const m = /^(.*?)\(([^()]*)\)$/.exec(token.trim());
  if (m) {
    const label = m[1]!.trim();
    const value = m[2]!.trim();
    return { label: label || value, value };
  }
  const plain = token.trim();
  if (!plain) return undefined;
  return { label: plain, value: plain };
}

/**
 * Detect every distinct variable across one or more SQL sources. When the same
 * name appears more than once, the *first occurrence that carries metadata*
 * (default / options) wins, matching Hue (a later bare `${n}` doesn't clobber an
 * earlier `${n=…}`). Returns them in first-seen order.
 */
export function detectVariables(sqlSources: string[]): DetectedVariable[] {
  const byName = new Map<string, DetectedVariable>();
  for (const sql of sqlSources) {
    const spans = exclusionSpans(sql);
    PLACEHOLDER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER.exec(sql)) !== null) {
      if (inAnySpan(match.index, spans)) continue;
      const parsed = parseBody(match[1]!);
      if (!parsed) continue;
      const existing = byName.get(parsed.name);
      if (!existing) {
        byName.set(parsed.name, parsed);
      } else if (!existing.hasDefault && parsed.hasDefault) {
        // Upgrade a bare placeholder once a default/options form is found.
        byName.set(parsed.name, { ...parsed });
      } else if (!existing.options && parsed.options) {
        byName.set(parsed.name, { ...existing, options: parsed.options });
      }
    }
  }
  return [...byName.values()];
}

/** Looks like an ISO date `YYYY-MM-DD`. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Looks like a datetime `YYYY-MM-DDTHH:MM` (optionally with seconds). */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const BOOL_RE = /^(true|false)$/i;

/** Infer the input widget type from a default value (design.md §5 型推論). */
export function inferType(detected: DetectedVariable): VariableType {
  if (detected.options && detected.options.length > 0) return 'select';
  const v = detected.defaultValue.trim();
  if (v === '') return 'text';
  if (BOOL_RE.test(v)) return 'checkbox';
  if (DATETIME_RE.test(v)) return 'datetime-local';
  if (DATE_RE.test(v)) return 'date';
  if (NUMBER_RE.test(v)) return 'number';
  return 'text';
}

/** A datetime-local input wants `T` between date and time. */
function normaliseDatetime(value: string): string {
  return value.includes('T') ? value : value.replace(' ', 'T');
}

/**
 * Build the persisted Variable list for a notebook from detected placeholders,
 * preserving any values the user already entered (matched by name). New
 * variables seed their `value` from the default; gone variables are dropped.
 */
export function reconcileVariables(detected: DetectedVariable[], previous: Variable[]): Variable[] {
  const prevByName = new Map(previous.map((v) => [v.name, v]));
  return detected.map((d) => {
    const type = inferType(d);
    const meta: VariableMeta = { type };
    if (d.options) meta.options = d.options;
    if (d.defaultValue) {
      meta.placeholder = type === 'datetime-local' ? normaliseDatetime(d.defaultValue) : d.defaultValue;
    }
    const prev = prevByName.get(d.name);
    // Keep a value the user already typed; otherwise seed from the default.
    let value = prev?.value ?? '';
    if (value === '' && d.defaultValue) {
      value = type === 'datetime-local' ? normaliseDatetime(d.defaultValue) : d.defaultValue;
    }
    return { name: d.name, value, meta };
  });
}

/** Outcome of resolving placeholders against the variable map. */
export interface SubstitutionResult {
  /** The statement with every `${…}` replaced. */
  text: string;
  /** Variables that had no value and no default — the run should be blocked. */
  missing: string[];
}

/**
 * Substitute every `${…}` in `statement` (skipping comments/strings) using the
 * supplied values, falling back to each placeholder's own default. A variable
 * with neither a value nor a default is reported in `missing` and left as-is.
 *
 * `values` maps name → current input value (e.g. from `notebook.variables`).
 */
export function substituteVariables(
  statement: string,
  values: Record<string, string>,
): SubstitutionResult {
  const spans = exclusionSpans(statement);
  const missing: string[] = [];
  PLACEHOLDER.lastIndex = 0;
  const text = statement.replace(PLACEHOLDER, (whole, body: string, offset: number) => {
    if (inAnySpan(offset, spans)) return whole; // inside comment/string — leave it
    const parsed = parseBody(body);
    if (!parsed) return whole;
    const supplied = values[parsed.name];
    const resolved =
      supplied !== undefined && supplied !== ''
        ? supplied
        : parsed.hasDefault
          ? parsed.defaultValue
          : undefined;
    if (resolved === undefined) {
      if (!missing.includes(parsed.name)) missing.push(parsed.name);
      return whole;
    }
    return resolved;
  });
  return { text, missing };
}

/** True when the source contains at least one (non-trivia) variable placeholder. */
export function hasVariables(sqlSources: string[]): boolean {
  return detectVariables(sqlSources).length > 0;
}
