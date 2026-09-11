import { readFileSync } from "node:fs";

export const schema = JSON.parse(readFileSync(new URL("./protocol.schema.json", import.meta.url), "utf8"));

// A dependency-free validator for the small JSON Schema vocabulary used by
// this protocol. Ports can use their usual Draft 2020-12 validator instead.
// Fail at load time if the schema grows beyond this implemented vocabulary.
const keywords = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "oneOf", "anyOf", "const", "enum",
  "type", "properties", "required", "additionalProperties", "items", "minItems", "minimum", "maximum", "minLength", "pattern",
]);
function supported(node) {
  for (const key of Object.keys(node)) {
    if (!keywords.has(key)) throw new Error(`Unsupported replay schema keyword: ${key}`);
  }
  for (const key of ["$defs", "properties"]) {
    for (const child of Object.values(node[key] ?? {})) supported(child);
  }
  for (const key of ["oneOf", "anyOf"]) for (const child of node[key] ?? []) supported(child);
  if (node.items !== undefined) supported(node.items);
  if (node.additionalProperties && typeof node.additionalProperties === "object") supported(node.additionalProperties);
}
supported(schema);

function resolve(rule) {
  if (rule.$ref === undefined) return rule;
  const name = rule.$ref.replace(/^#\/\$defs\//, "");
  if (!Object.hasOwn(schema.$defs, name)) throw new Error(`Unknown replay schema reference: ${rule.$ref}`);
  return schema.$defs[name];
}

function matches(value, rule) {
  if (rule.$ref !== undefined) return matches(value, resolve(rule));
  if (rule.oneOf && rule.oneOf.filter(option => matches(value, option)).length !== 1) return false;
  if (rule.anyOf && !rule.anyOf.some(option => matches(value, option))) return false;
  if (Object.hasOwn(rule, "const") && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const accepted = types.some(type => {
      if (type === "null") return value === null;
      if (type === "array") return Array.isArray(value);
      if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
      if (type === "integer") return Number.isInteger(value);
      if (type === "number") return typeof value === "number" && Number.isFinite(value);
      return typeof value === type;
    });
    if (!accepted) return false;
  }
  if (typeof value === "number" && ((rule.minimum !== undefined && value < rule.minimum)
      || (rule.maximum !== undefined && value > rule.maximum))) return false;
  if (typeof value === "string" && ((rule.minLength !== undefined && value.length < rule.minLength)
      || (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)))) return false;
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) return false;
    if (rule.items && !value.every(item => matches(item, rule.items))) return false;
  } else if (value !== null && typeof value === "object") {
    if ((rule.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(rule.properties ?? {}, key)) {
        if (!matches(item, rule.properties[key])) return false;
      } else if (rule.additionalProperties === false) return false;
      else if (typeof rule.additionalProperties === "object" && !matches(item, rule.additionalProperties)) return false;
    }
  }
  return true;
}

// An alternative is a candidate for a record when every constant-valued
// property it declares (op, event, status, ...) agrees with the record. This
// is only a diagnostic aid: acceptance is decided by matches() alone.
function candidate(value, option) {
  option = resolve(option);
  if (option.oneOf || option.anyOf) return (option.oneOf ?? option.anyOf).some(nested => candidate(value, nested));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  return Object.entries(option.properties ?? {}).every(([key, property]) =>
    !Object.hasOwn(property, "const") || value[key] === property.const);
}

// Path of the first violation, or undefined when the value matches. Paths name
// members only; observed values never enter a diagnostic.
function violation(value, rule, path) {
  if (matches(value, rule)) return undefined;
  if (rule.$ref !== undefined) return violation(value, resolve(rule), path);
  const options = rule.oneOf ?? rule.anyOf;
  if (options) {
    const candidates = options.filter(option => candidate(value, option));
    return candidates.length === 1 ? violation(value, candidates[0], path) : path;
  }
  if (Array.isArray(value)) {
    const index = rule.items ? value.findIndex(item => !matches(item, rule.items)) : -1;
    return index < 0 ? path : violation(value[index], rule.items, `${path}[${index}]`);
  }
  if (value !== null && typeof value === "object") {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key}`;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(rule.properties ?? {}, key)) {
        if (!matches(item, rule.properties[key])) return violation(item, rule.properties[key], `${path}.${key}`);
      } else if (rule.additionalProperties === false) return `${path}.${key}`;
      else if (typeof rule.additionalProperties === "object" && !matches(item, rule.additionalProperties)) {
        return violation(item, rule.additionalProperties, `${path}.${key}`);
      }
    }
  }
  return path;
}

function definitionRule(definition) {
  if (!Object.hasOwn(schema.$defs, definition)) throw new Error(`Unknown replay schema definition: ${definition}`);
  return schema.$defs[definition];
}

export function schemaViolation(value, definition, root = definition) {
  return violation(value, definitionRule(definition), root);
}

export function assertSchema(value, definition) {
  const path = schemaViolation(value, definition);
  if (path !== undefined) throw new Error(`Malformed replay ${definition}${path === definition ? "" : ` at ${path}`}`);
}
