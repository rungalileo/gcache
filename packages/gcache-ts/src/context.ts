import { AsyncLocalStorage } from "node:async_hooks";

export class GCacheContext {
  private readonly storage = new AsyncLocalStorage<boolean>();

  isEnabled(): boolean {
    return this.storage.getStore() ?? false;
  }

  enable<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.run(true, fn);
  }

  disable<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.run(false, fn);
  }

  private async run<T>(enabled: boolean, fn: () => T | Promise<T>): Promise<T> {
    return await this.storage.run(enabled, async () => await fn());
  }
}
