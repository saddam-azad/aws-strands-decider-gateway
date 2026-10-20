/**
 * PII redaction, applied to `state` before it leaves the account and *before* the cache
 * key is computed — so a redacted request and its unredacted twin share one cache entry
 * only after both have been through this.
 */
import type { State } from "./types.ts";

const BUILTIN = {
  // order matters: cards before phones, or card digits get eaten as a phone number
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  card: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g,
  phone: /(?<!\d)\+?\d[\d\s().-]{7,}\d(?!\d)/g,
} as const;

export type BuiltinRedaction = keyof typeof BUILTIN;
const ORDER: readonly BuiltinRedaction[] = ["email", "card", "phone"];

interface Rule {
  readonly label: string;
  readonly pattern: RegExp;
}

/** "email" | "phone" | "card" or any other string, treated as a case-insensitive regex source. */
export function compileRedactions(specs: readonly string[]): Rule[] {
  const wanted = new Set(specs);
  const rules: Rule[] = ORDER.filter((n) => wanted.has(n)).map((n) => ({ label: n, pattern: BUILTIN[n] }));
  for (const spec of specs) {
    if (spec in BUILTIN) continue;
    try {
      rules.push({ label: "custom", pattern: new RegExp(spec, "gi") });
    } catch (cause) {
      throw new Error(`invalid redaction pattern ${JSON.stringify(spec)}`, { cause });
    }
  }
  return rules;
}

export function redact<T extends State>(state: T, rules: readonly Rule[]): T {
  if (rules.length === 0) return state;
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return rules.reduce((s, r) => s.replace(r.pattern, `[REDACTED:${r.label}]`), value);
    if (Array.isArray(value)) return value.map(scrub);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  return scrub(state) as T;
}
