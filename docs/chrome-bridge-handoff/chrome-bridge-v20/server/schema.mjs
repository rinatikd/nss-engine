// Minimal dependency-free validator for MCP tool arguments.
function validateValue(schema, value, key) {
  const bad = () => Error('Invalid argument: ' + key);
  if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw bad();
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw bad();
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 10000) || value.length < (schema.minLength ?? 0)) throw bad();
    if (schema.enum && !schema.enum.includes(value)) throw bad();
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw bad();
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) ||
        value.length < (schema.minItems ?? 0) ||
        value.length > (schema.maxItems ?? Infinity)) throw bad();
    if (schema.uniqueItems && new Set(value).size !== value.length) throw bad();
    if (!schema.items || typeof schema.items !== 'object') throw Error('Unsupported array item schema: ' + key);
    for (let index = 0; index < value.length; index++)
      validateValue(schema.items, value[index], key + '[' + index + ']');
  } else {
    throw Error('Unsupported argument schema: ' + key);
  }
}

// Minimal validator for MCP tool arguments (no external dependencies).
export function validateArgs(tool, args) {
  const props = tool.inputSchema.properties || {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw Error('Arguments must be an object');
  for (const k of Object.keys(args)) if (!Object.hasOwn(props, k)) throw Error('Unexpected argument: ' + k);
  for (const k of tool.inputSchema.required || []) if (!Object.hasOwn(args, k)) throw Error('Missing argument: ' + k);
  for (const [k, v] of Object.entries(args)) validateValue(props[k], v, k);
}
