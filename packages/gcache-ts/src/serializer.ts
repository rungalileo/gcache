export interface Serializer<T = unknown> {
  dump(value: T): Promise<string | Buffer>;
  load(value: string | Buffer): Promise<T>;
}

export class JsonSerializer<T = unknown> implements Serializer<T> {
  async dump(value: T): Promise<string> {
    return JSON.stringify(value);
  }

  async load(value: string | Buffer): Promise<T> {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value) as T;
  }
}
