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
}

export class GCacheKey {
  readonly keyType: string;
  readonly id: string;
  readonly useCase: string;
  readonly args: ReadonlyArray<readonly [string, string]>;
  readonly prefix: string;
  readonly urn: string;
  readonly defaultConfig: GCacheKeyConfig | null;
  readonly serializer: Serializer<unknown> | null;

  constructor(init: GCacheKeyInit) {
    this.keyType = init.keyType;
    this.id = init.id;
    this.useCase = init.useCase;
    this.args = init.args ?? [];
    this.defaultConfig = init.defaultConfig ?? null;
    this.serializer = init.serializer ?? null;

    this.prefix = `${init.urnPrefix ?? "urn"}:${this.keyType}:${this.id}`;
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
