export function parseTemplatePath(expression) {
  const source = expression.trim().replace(/^\$/u, '');
  if (!source) {
    throw new Error('template expression must not be empty');
  }

  let index = 0;
  let token = '';
  const tokens = [];

  const pushToken = () => {
    if (!token) {
      throw new Error(`invalid template path: ${expression}`);
    }
    tokens.push(token);
    token = '';
  };

  while (index < source.length) {
    const char = source[index];
    if (char === '.') {
      pushToken();
      index += 1;
      continue;
    }

    if (char === '[') {
      if (token) {
        pushToken();
      }
      const quote = source[index + 1];
      if (['"', "'"].includes(quote)) {
        const endQuote = source.indexOf(quote, index + 2);
        const close = source.indexOf(']', endQuote + 1);
        if (endQuote === -1 || close === -1) {
          throw new Error(`invalid bracket access in template: ${expression}`);
        }
        tokens.push(source.slice(index + 2, endQuote));
        index = close + 1;
        continue;
      }

      const close = source.indexOf(']', index + 1);
      const rawSegment = source.slice(index + 1, close).trim();
      if (close === -1 || !/^\d+$/u.test(rawSegment)) {
        throw new Error(`invalid bracket access in template: ${expression}`);
      }
      tokens.push(rawSegment);
      index = close + 1;
      continue;
    }

    token += char;
    index += 1;
  }

  if (token) {
    pushToken();
  }

  return tokens;
}

export function readPathValue(context, expression) {
  const [root, ...segments] = parseTemplatePath(expression);
  let current = context[root];
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return '';
    }
    current = current[segment];
  }
  if (current === undefined || current === null) {
    return '';
  }
  return current;
}

export function stringifyValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function renderString(template, context) {
  return template.replace(/\{\{\s*(.+?)\s*\}\}/gu, (_, expression) =>
    stringifyValue(readPathValue(context, expression))
  );
}

export function pruneRenderedValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value;
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry) => pruneRenderedValue(entry)).filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, entry]) => [key, pruneRenderedValue(entry)])
      .filter(([, entry]) => entry !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function renderSchemaValue(value, context) {
  if (typeof value === 'string') {
    const fullMatch = value.match(/^\s*\{\{\s*(.+?)\s*\}\}\s*$/u);
    if (fullMatch) {
      return pruneRenderedValue(readPathValue(context, fullMatch[1]));
    }
    if (!value.includes('{{')) {
      return pruneRenderedValue(value);
    }
    return pruneRenderedValue(renderString(value, context));
  }
  if (Array.isArray(value)) {
    return pruneRenderedValue(value.map((entry) => renderSchemaValue(entry, context)));
  }
  if (value && typeof value === 'object') {
    return pruneRenderedValue(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, renderSchemaValue(entry, context)])
      )
    );
  }
  return pruneRenderedValue(value);
}
