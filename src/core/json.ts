import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

export function asJsonObject(value: unknown, name: string): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) throw new Error(`${name} must be a JSON object`);
  return value as JsonObject;
}

/** Stable JSON used for graph and input fingerprints. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("JSON value is too deeply nested");
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Small, bounded JSON Schema validator for graph artifacts. It intentionally
 * supports only the data-shape keywords a graph needs and never evaluates
 * schema-provided code or formats.
 */
export function validateJsonSchema(value: unknown, schema: unknown, path = "$", depth = 0): SchemaIssue[] {
  if (!isRecord(schema) || depth > 48) return [{ path, message: "schema is invalid or too deeply nested" }];
  const issues: SchemaIssue[] = [];
  const type = schema.type;
  const types = typeof type === "string" ? [type] : Array.isArray(type) && type.every((item) => typeof item === "string") ? type : undefined;
  if (types && !types.some((candidate) => matchesType(value, candidate))) {
    issues.push({ path, message: `expected ${types.join(" or ")}` });
    return issues;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))) {
    issues.push({ path, message: "value is not in enum" });
  }
  if (schema.const !== undefined && canonicalJson(schema.const) !== canonicalJson(value)) {
    issues.push({ path, message: "value does not match const" });
  }
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) issues.push({ path, message: "string is shorter than minLength" });
  if (typeof schema.maxLength === "number" && typeof value === "string" && value.length > schema.maxLength) issues.push({ path, message: "string is longer than maxLength" });
  if (typeof schema.pattern === "string" && typeof value === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) issues.push({ path, message: "string does not match pattern" });
    } catch {
      issues.push({ path, message: "schema pattern is invalid" });
    }
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) issues.push({ path, message: "number is below minimum" });
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) issues.push({ path, message: "number is above maximum" });
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path, message: "array is shorter than minItems" });
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issues.push({ path, message: "array is longer than maxItems" });
    if (schema.items !== undefined) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`, depth + 1)));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) issues.push({ path, message: `missing required property ${key}` });
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) issues.push(...validateJsonSchema(value[key], child, `${path}.${key}`, depth + 1));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
    }
  }
  return issues.slice(0, 100);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    default: return false;
  }
}
