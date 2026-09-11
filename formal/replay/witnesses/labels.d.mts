import type { FeatureHistory } from "./index.mjs";
export function actionLabels(histories: readonly FeatureHistory[]): Set<string>;
export function flowLabels(histories: readonly FeatureHistory[], fixtures?: boolean): Set<string>;
