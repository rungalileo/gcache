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

    const rawPrefix = `${this.urnPrefix}:${this.keyType}:${this.id}`;
    this.prefix = this.trackForInvalidation ? redisClusterHashTag(invalidationPrefix(this.urnPrefix, this.keyType, this.id)) : rawPrefix;
    const args = this.args.length > 0 ? `?${this.args.map(([name, value]) => `${name}=${value}`).join("&")}` : "";
    this.urn = `${this.prefix}${args}#${this.useCase}`;
  }

  toString(): string {
    return this.urn;
  }
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
  return `${urnPrefix}:${keyType}:${id}`;
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
