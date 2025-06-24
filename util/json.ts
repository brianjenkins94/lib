import { visit, parseTree, getNodeValue, JSONVisitor } from "jsonc-parser";

function escapeString(string: string): string {
  return string.replace(/[\\"\u0000-\u001F]/g, function (char) {
    switch (char) {
      case '"':
        return '\\"';
      case '\\':
        return '\\\\';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
    }
  });
}

// TODO: Review
function serialize(
  value: any,
  replacer?: ((this: any, key: string, value: any) => any) | (string | number)[] | null,
  space?: string | number
): Uint8Array[] {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  const indent = typeof space === "number"
    ? " ".repeat(Math.min(10, space))
    : typeof space === "string"
      ? space.slice(0, 10)
      : "";

  const propertyList = Array.isArray(replacer) ? replacer.map(String) : null;
  const replacerFn = typeof replacer === "function" ? replacer : null;
  const stack: any[] = [];

  function str(key: string, holder: any, depth: number): boolean {
    let value = holder[key];

    if (replacerFn) {
      value = replacerFn.call(holder, key, value);
    }

    if (value === null) {
      chunks.push(encoder.encode("null"));
      return true;
    }

    if (typeof value === "string") {
      chunks.push(encoder.encode(`"${escapeString(value)}"`));
      return true;
    }

    if (typeof value === "number") {
      chunks.push(encoder.encode(isFinite(value) ? String(value) : "null"));
      return true;
    }

    if (typeof value === "boolean") {
      chunks.push(encoder.encode(String(value)));
      return true;
    }

    if (typeof value === "bigint") {
      throw new TypeError("Cannot serialize BigInt");
    }

    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
      // For arrays, serialize as null; for objects, omit.
      return false;
    }

    if (typeof value === "object") {
      if (typeof value.toJSON === "function") {
        value = value.toJSON(key);
        return str("", { "": value }, depth);
      }

      if (stack.includes(value)) {
        throw new TypeError("Converting circular structure to JSON");
      }

      stack.push(value);
      const step = indent ? "\n" + indent.repeat(depth + 1) : "";
      const stepEnd = indent ? "\n" + indent.repeat(depth) : "";

      if (Array.isArray(value)) {
        chunks.push(encoder.encode("["));
        const len = value.length;
        for (let i = 0; i < len; i++) {
          if (i > 0) chunks.push(encoder.encode(","));
          if (indent) chunks.push(encoder.encode(step));
          const ok = str(String(i), value, depth + 1);
          if (!ok) chunks.push(encoder.encode("null"));
        }
        if (indent && len > 0) chunks.push(encoder.encode(stepEnd));
        chunks.push(encoder.encode("]"));
      } else {
        chunks.push(encoder.encode("{"));
        const keys = propertyList || Object.keys(value);
        let first = true;
        for (const k of keys) {
          let subValue = value[k];
          if (replacerFn) subValue = replacerFn.call(value, k, subValue);

          if (subValue === undefined || typeof subValue === "function" || typeof subValue === "symbol") {
            continue;
          }

          if (!first) chunks.push(encoder.encode(","));
          if (indent) chunks.push(encoder.encode(step));
          chunks.push(encoder.encode(`"${escapeString(k)}"`));
          chunks.push(encoder.encode(indent ? ": " : ":"));

          const ok = str(k, value, depth + 1);
          if (!ok) chunks.push(encoder.encode("null"));

          first = false;
        }
        if (indent && !first) chunks.push(encoder.encode(stepEnd));
        chunks.push(encoder.encode("}"));
      }

      stack.pop();
      return true;
    }

    return false;
  }

  const topLevel = { "": value };
  const ok = str("", topLevel, 0);
  if (!ok) throw new TypeError("Value is not JSON serializable");

  return chunks;
}

export function stringify(value: any, replacer?: (this: any, key: string, value: any) => any, space?: string | number): string | Uint8Array | undefined {
  if (!(value instanceof Uint8Array)) {
    return JSON.stringify(value, replacer, space);
  }

  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  const chunks = serialize(value, replacer, space);

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);

  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);

    offset += chunk.length;
  }

  return result;
}

export function parse(text, reviver?, options?: JSONVisitor) {
  if (text instanceof Uint8Array) {
    // TODO: https://github.com/evanw/uint8array-json-parser/blob/master/uint8array-json-parser.ts
    throw new Error("Uint8Array input not yet implemented.");
  }

  if (reviver !== undefined) {
    throw new Error("`reviver` not yet implemented.")
  }

  if (options === undefined) {
    return JSON.parse(text, reviver);
  }

  visit(text, options, { "allowTrailingComma": true });

  const root = parseTree(text, undefined, { "allowTrailingComma": true });

  return getNodeValue(root);
}
