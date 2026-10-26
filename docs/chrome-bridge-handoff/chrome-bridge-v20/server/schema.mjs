// РњРёРЅРёРјР°Р»СЊРЅС‹Р№ РІР°Р»РёРґР°С‚РѕСЂ Р°СЂРіСѓРјРµРЅС‚РѕРІ РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ (Р±РµР· Р·Р°РІРёСЃРёРјРѕСЃС‚РµР№).
export function validateArgs(tool, args) {
  const props = tool.inputSchema.properties || {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw Error('Arguments must be an object');
  for (const k of Object.keys(args)) if (!Object.hasOwn(props, k)) throw Error('Unexpected argument: ' + k);
  for (const k of tool.inputSchema.required || []) if (!Object.hasOwn(args, k)) throw Error('Missing argument: ' + k);
  for (const [k, v] of Object.entries(args)) {
    const s = props[k];
    const bad = () => Error('Invalid argument: ' + k);
    if (s.type === 'integer') {
      if (!Number.isInteger(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity)) throw bad();
    } else if (s.type === 'boolean') {
      if (typeof v !== 'boolean') throw bad();
    } else if (s.type === 'string') {
      if (typeof v !== 'string' || v.length > (s.maxLength ?? 10000) || v.length < (s.minLength ?? 0)) throw bad();
      if (s.enum && !s.enum.includes(v)) throw bad();
      if (s.pattern && !new RegExp(s.pattern).test(v)) throw bad();
    } else throw Error('Unsupported argument schema: ' + k);
  }
}

