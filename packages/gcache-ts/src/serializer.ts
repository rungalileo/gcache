export interface Serializer<T = unknown> {
  dump(value: T): Promise<string | Buffer>;
  load(value: string | Buffer): Promise<T>;
}

const JSON_UNDEFINED_SENTINEL = "__gcache_json_undefined_v1__";

export class JsonSerializer<T = unknown> implements Serializer<T> {
  async dump(value: T): Promise<string> {
    if (value === undefined) {
      return JSON_UNDEFINED_SENTINEL;
    }

    const payload = JSON.stringify(value);
    if (payload === undefined) {
      throw new Error("GCache JSON serializer cannot serialize this value");
    }
    return payload;
  }

  async load(value: string | Buffer): Promise<T> {
    const payload = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    if (payload === JSON_UNDEFINED_SENTINEL) {
      return undefined as T;
    }
    return JSON.parse(payload) as T;
  }
}
