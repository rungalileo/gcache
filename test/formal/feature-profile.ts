import type { Fixture, Input, Observation } from "./behavior-driver.js";

// Profiles bind declared external actions to a language implementation. Their
// inputs cannot inspect expected model state or use it to schedule effects.
export interface Action {
  choices?: readonly number[];
  input: (choice: number, observed: Observation) => Input;
}

export interface Profile {
  explicitInputs?: boolean;
  markerIO?: boolean;
  compressionIO?: boolean;
  readIO?: boolean;
  policyErrorIO?: boolean;
  diagnosticConfigErrors?: boolean;
  diagnosticFutureOffsets?: boolean;
  diagnosticAge?: "shadowAge" | "recoveryAge" | "none";
  fixture: Fixture | ((choice: number) => Fixture);
  initChoices?: readonly number[];
  setup: Input[];
  actions: Record<string, Action>;
}
