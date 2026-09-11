// Labels shared by every feature profile: each declared action, every recovery
// and shadow outcome, and (for recovery/shadow) the selected init fixture.
export function actionLabels(histories) {
  const seen = new Set();
  for (const { steps } of histories) for (const step of steps) seen.add(`action:${step.action}`);
  return seen;
}
export function flowLabels(histories, fixtures = false) {
  const seen = new Set();
  for (const { steps } of histories) {
    if (fixtures) seen.add(`fixture:${steps[0].choice}`);
    for (const [i, step] of steps.entries()) {
      seen.add(`action:${step.action}`);
      if (i === 0) continue;
      for (const outcome of step.expected.recovery.concat(step.expected.shadow)) seen.add(`outcome:${outcome}`);
    }
  }
  return seen;
}
