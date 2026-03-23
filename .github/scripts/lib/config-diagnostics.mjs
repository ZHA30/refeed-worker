const SIMPLE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]*$/u;

function formatPathSegment(segment, index) {
  if (typeof segment === "number") {
    return `[${segment}]`;
  }
  if (SIMPLE_KEY_PATTERN.test(segment)) {
    return index === 0 ? segment : `.${segment}`;
  }
  return `[${JSON.stringify(segment)}]`;
}

function parsePathString(path) {
  if (!path || path === "(root)") {
    return [];
  }

  const segments = [];
  let index = 0;

  while (index < path.length) {
    if (path[index] === ".") {
      index += 1;
      continue;
    }

    if (path[index] === "[") {
      const closing = path.indexOf("]", index);
      const rawSegment = path.slice(index + 1, closing);
      if (/^\d+$/u.test(rawSegment)) {
        segments.push(Number.parseInt(rawSegment, 10));
      } else {
        segments.push(JSON.parse(rawSegment));
      }
      index = closing + 1;
      continue;
    }

    let end = index;
    while (end < path.length && path[end] !== "." && path[end] !== "[") {
      end += 1;
    }
    segments.push(path.slice(index, end));
    index = end;
  }

  return segments;
}

function buildLineStarts(rawText) {
  const starts = [0];
  for (let index = 0; index < rawText.length; index += 1) {
    if (rawText[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineForPosition(lineStarts, position) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= position) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return high + 1;
}

function columnForPosition(lineStarts, position) {
  const line = lineForPosition(lineStarts, position);
  const lineStart = lineStarts[line - 1] ?? 0;
  return position - lineStart + 1;
}

function skipWhitespace(rawText, index) {
  let cursor = index;
  while (cursor < rawText.length && /\s/u.test(rawText[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function parseStringLiteral(rawText, index) {
  let cursor = index + 1;
  let escaped = false;

  while (cursor < rawText.length) {
    const char = rawText[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (char === '"') {
      return {
        value: JSON.parse(rawText.slice(index, cursor + 1)),
        end: cursor + 1,
      };
    }
    cursor += 1;
  }

  throw new Error("unterminated JSON string literal");
}

function consumePrimitive(rawText, index, literal) {
  if (!rawText.startsWith(literal, index)) {
    throw new Error(`invalid JSON token at ${index}`);
  }
  return index + literal.length;
}

function consumeNumber(rawText, index) {
  const match = rawText
    .slice(index)
    .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
  if (!match) {
    throw new Error(`invalid JSON number at ${index}`);
  }
  return index + match[0].length;
}

function walkValue(rawText, index, pathSegments, lineStarts, keyLocations) {
  const cursor = skipWhitespace(rawText, index);
  const char = rawText[cursor];

  if (char === "{") {
    return walkObject(rawText, cursor, pathSegments, lineStarts, keyLocations);
  }
  if (char === "[") {
    return walkArray(rawText, cursor, pathSegments, lineStarts, keyLocations);
  }
  if (char === '"') {
    return parseStringLiteral(rawText, cursor).end;
  }
  if (char === "t") {
    return consumePrimitive(rawText, cursor, "true");
  }
  if (char === "f") {
    return consumePrimitive(rawText, cursor, "false");
  }
  if (char === "n") {
    return consumePrimitive(rawText, cursor, "null");
  }

  return consumeNumber(rawText, cursor);
}

function walkObject(rawText, index, pathSegments, lineStarts, keyLocations) {
  let cursor = index + 1;

  while (true) {
    cursor = skipWhitespace(rawText, cursor);
    if (rawText[cursor] === "}") {
      return cursor + 1;
    }

    const keyStart = cursor;
    const keyToken = parseStringLiteral(rawText, cursor);
    const nextPath = [...pathSegments, keyToken.value];
    keyLocations.set(buildConfigPath(nextPath), {
      line: lineForPosition(lineStarts, keyStart),
      column: columnForPosition(lineStarts, keyStart),
      path: buildConfigPath(nextPath),
      key: keyToken.value,
    });

    cursor = skipWhitespace(rawText, keyToken.end);
    if (rawText[cursor] !== ":") {
      throw new Error(`expected ":" after JSON object key at ${cursor}`);
    }

    cursor = walkValue(rawText, cursor + 1, nextPath, lineStarts, keyLocations);
    cursor = skipWhitespace(rawText, cursor);

    if (rawText[cursor] === "}") {
      return cursor + 1;
    }
    if (rawText[cursor] !== ",") {
      throw new Error(`expected "," in JSON object at ${cursor}`);
    }
    cursor += 1;
  }
}

function walkArray(rawText, index, pathSegments, lineStarts, keyLocations) {
  let cursor = index + 1;
  let itemIndex = 0;

  while (true) {
    cursor = skipWhitespace(rawText, cursor);
    if (rawText[cursor] === "]") {
      return cursor + 1;
    }

    cursor = walkValue(
      rawText,
      cursor,
      [...pathSegments, itemIndex],
      lineStarts,
      keyLocations
    );
    itemIndex += 1;
    cursor = skipWhitespace(rawText, cursor);

    if (rawText[cursor] === "]") {
      return cursor + 1;
    }
    if (rawText[cursor] !== ",") {
      throw new Error(`expected "," in JSON array at ${cursor}`);
    }
    cursor += 1;
  }
}

function indexJsonKeys(rawText) {
  const keyLocations = new Map();
  const lineStarts = buildLineStarts(rawText);
  walkValue(rawText, 0, [], lineStarts, keyLocations);
  return keyLocations;
}

export function buildConfigPath(pathOrSegments = [], childKey) {
  const baseSegments = Array.isArray(pathOrSegments)
    ? pathOrSegments
    : parsePathString(pathOrSegments);
  const pathSegments =
    childKey === undefined ? baseSegments : [...baseSegments, childKey];

  if (pathSegments.length === 0) {
    return "(root)";
  }

  return pathSegments
    .map((segment, index) => formatPathSegment(segment, index))
    .join("");
}

export function formatConfigPath(pathOrSegments = [], childKey) {
  return buildConfigPath(pathOrSegments, childKey);
}

export function collectJsonPathLocations(rawText) {
  return indexJsonKeys(rawText);
}

export function findClosestLocation(keyLocations, pathOrSegments = []) {
  const segments = Array.isArray(pathOrSegments)
    ? pathOrSegments
    : parsePathString(pathOrSegments);

  for (let length = segments.length; length > 0; length -= 1) {
    const path = buildConfigPath(segments.slice(0, length));
    const match = keyLocations.get(path);
    if (match) {
      return match;
    }
  }

  return { line: null, column: null, key: "", path: "" };
}

export function lookupPathLine(keyLocations, pathOrSegments = []) {
  return findClosestLocation(keyLocations, pathOrSegments).line ?? null;
}

export function locateJsonParseError(rawText, error) {
  const message = `${error?.message ?? ""}`;
  const match = message.match(/position (\d+)/u);
  if (!match) {
    return { line: null, column: null, message };
  }

  const position = Number.parseInt(match[1], 10);
  if (Number.isNaN(position)) {
    return { line: null, column: null, message };
  }

  const lineStarts = buildLineStarts(rawText);
  return {
    line: lineForPosition(lineStarts, position),
    column: columnForPosition(lineStarts, position),
    message,
  };
}

export function parseJsonDocument(rawText) {
  try {
    return {
      value: JSON.parse(rawText),
      keyLocations: collectJsonPathLocations(rawText),
      parseError: null,
    };
  } catch (error) {
    return {
      value: undefined,
      keyLocations: new Map(),
      parseError: locateJsonParseError(rawText, error),
    };
  }
}

export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) => {
    const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }
    return left.message.localeCompare(right.message);
  });
}
