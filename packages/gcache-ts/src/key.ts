import type { GCacheKeyConfig } from "./config.js";
import type { Serializer } from "./serializer.js";

export interface GCacheKeyInit {
  readonly keyType: string;
  readonly id: string;
  readonly useCase: string;
  readonly args?: ReadonlyArray<readonly [string, string]>;
  readonly urnPrefix?: string;
  readonly defaultConfig?: GCacheKeyConfig | null;
  readonly serializer?: Serializer<unknown> | null;
  readonly trackForInvalidation?: boolean;
}

export class GCacheKey {
  readonly keyType: string;
  readonly id: string;
  readonly useCase: string;
  readonly args: ReadonlyArray<readonly [string, string]>;
  readonly urnPrefix: string;
  readonly prefix: string;
  readonly urn: string;
  readonly defaultConfig: GCacheKeyConfig | null;
  readonly serializer: Serializer<unknown> | null;
  readonly trackForInvalidation: boolean;

  constructor(init: GCacheKeyInit) {
    this.keyType = init.keyType;
    this.id = init.id;
    this.useCase = init.useCase;
    this.args = init.args ?? [];
    this.defaultConfig = init.defaultConfig ?? null;
    this.serializer = init.serializer ?? null;
    this.trackForInvalidation = init.trackForInvalidation ?? false;
    this.urnPrefix = init.urnPrefix ?? "urn";

    const rawPrefix = joinUrnComponents(this.urnPrefix, this.keyType, this.id);
    this.prefix = this.trackForInvalidation ? redisClusterHashTag(invalidationPrefix(this.urnPrefix, this.keyType, this.id)) : rawPrefix;
    // Sorted by name, matching Python's GCacheKey and Go's ValueKey. Every writer of a
    // real key sorts: Python's cached() sorts before constructing, Go's ValueKey sorts, and
    // Python's constructor now does too. This one did not, so the same logical args in a
    // different order built a different Redis entry here than in the other two clients.
    //
    // normalizeArgs' own localeCompare sort is a separate concern -- it converts an OBJECT
    // to tuples, where JS key order carries no meaning. This sorts the tuple form as well,
    // so both entry points agree. Byte-ordinal rather than localeCompare, to match Python
    // and Go on non-ASCII names. Not `<`: JavaScript compares UTF-16 CODE UNITS, so a
    // supplementary character sorts below U+E000 (its lead surrogate is 0xD800) while
    // Python and Go put it above. Measured for "\uE000" vs "\u{10000}" -- Python and Go
    // say a<b, `<` in JS says b<a. Not localeCompare either: that is locale-sensitive.
    //
    // Stable, so two args sharing a name keep their input order in every client.
    const sortedArgs = [...this.args].sort(([l], [r]) => compareCodePoints(l, r));
    const args =
      sortedArgs.length > 0
        ? `?${sortedArgs.map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`).join("&")}`
        : "";
    this.urn = `${this.prefix}${args}#${encodeComponent(this.useCase)}`;
  }

  toString(): string {
    return this.urn;
  }
}

/** Compares by Unicode CODE POINT, matching Python's `<` and Go's byte-wise UTF-8 order.
 *
 * JavaScript's `<` on strings compares UTF-16 code units, which disagrees with both above the
 * basic multilingual plane: a supplementary character is a surrogate pair starting at 0xD800,
 * so it sorts below anything in U+E000..U+FFFF. Arg names are caller-supplied, so this is
 * reachable rather than theoretical.
 */
function compareCodePoints(left: string, right: string): number {
  const l = Array.from(left);
  const r = Array.from(right);
  const shared = Math.min(l.length, r.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = l[i]!.codePointAt(0)! - r[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return l.length - r.length;
}

export function normalizeArgs(args: Record<string, string | number | boolean | bigint | null | undefined>): Array<[string, string]> {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name, String(value)] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function invalidationPrefix(urnPrefix: string, keyType: string, id: string): string {
  assertRedisHashTagComponent("urnPrefix", urnPrefix);
  assertRedisHashTagComponent("keyType", keyType);
  assertRedisHashTagComponent("id", id);
  return joinUrnComponents(urnPrefix, keyType, id);
}

export function redisClusterHashTag(value: string): string {
  assertRedisHashTagComponent("value", value);
  return `{${value}}`;
}

function assertRedisHashTagComponent(name: string, value: string): void {
  if (value.includes("{") || value.includes("}")) {
    throw new Error(`Redis Cluster hash tag components must not contain braces: ${name}`);
  }
}

function joinUrnComponents(...components: readonly string[]): string {
  return components.map(encodeComponent).join(":");
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}
