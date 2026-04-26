export type JsonPrimitive = string | number | boolean | null;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function getJsonObjectProperty(
  object: JsonObject,
  key: string,
): JsonValue | undefined {
  return object[key];
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (!isJsonObject(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function parseJsonValue(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
