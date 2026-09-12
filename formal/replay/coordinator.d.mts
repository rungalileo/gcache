import type { Binding } from "./bindings.mjs";

export const protocolVersion: 1;
export const settlement: "causally-ready-v1";
export class ReplayCoordinator {
  dispatch(request: unknown): Record<string, unknown>;
}
