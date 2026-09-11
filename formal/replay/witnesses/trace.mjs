import { readFileSync } from "node:fs";
import { itfSignedInteger, record } from "../itf.mjs";

// Shared helpers for the language-neutral witness classifiers. Every rule keys
// on the authoritative explicit input record written by the Quint transition;
// the optional simulator annotations (mbt::actionTaken/nondetPicks) are never
// consulted. Classifiers read only these inputs, public observations and, where
// a rule needs it, private model predictions. They never observe a driver.
export function readTrace(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function traceStates(raw, context) {
  const states = record(raw, context).states;
  if (!Array.isArray(states)) throw new Error(`${context}: missing witness states`);
  return states;
}
export function explicitInput(state, context) {
  const input = record(record(state, context).input, context);
  if (typeof input.name !== "string") throw new Error(`${context}: missing explicit witness input`);
  return { name: input.name, choice: itfSignedInteger(input.choice, context) };
}
export function witnessCommand(name, choice = -1) {
  return `${name}:${choice}`;
}
// Convert every ITF integer inside a value into a safe JavaScript number.
// Reject precision loss instead of rounding unbounded Quint integers.
export function decodeIntegers(value, context) {
  if (Array.isArray(value)) return value.map(item => decodeIntegers(item, context));
  if (value === null || typeof value !== "object") return value;
  if (Object.hasOwn(value, "#bigint")) {
    const text = value["#bigint"];
    if (Object.keys(value).length !== 1 || typeof text !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(text)
      || !Number.isSafeInteger(Number(text))) throw new Error(`${context}: unsafe witness integer`);
    return Number(text);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeIntegers(item, context)]));
}
export function integer(value, context) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${context}: missing witness state integer`);
  return value;
}
// Private model predictions of every state, decoded once per history.
export function privateStates(raw, context) {
  return traceStates(raw, context).map(state => decodeIntegers(record(record(state, context).s, context), context));
}
