import type { Binding } from "./bindings.mjs";

export const protocolVersion: 1;
export const settlement: "causally-ready-v1";
/** protocol.schema.json definition named by a prepare result's `observation`. */
export type ObservationDefinition = Binding["observation"];
export class ReplayCoordinator {
  dispatch(request: unknown): Record<string, unknown>;
}
