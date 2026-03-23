import path from 'node:path';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function redactSensitiveText(input, options = {}) {
  if (input === undefined || input === null) {
    return '';
  }

  let text = String(input);

  text = text.replace(/https?:\/\/[^\s)'"`]+/gu, '<redacted-url>');

  const configRoot = options.configRoot ? path.resolve(options.configRoot) : null;
  if (configRoot) {
    const escapedConfigRoot = escapeRegExp(configRoot.replace(/\\/gu, '/'));
    text = text.replace(new RegExp(`${escapedConfigRoot}/?`, 'gu'), 'config/');
  }

  text = text.replace(/(^|[\s:(])(?:[A-Za-z]:)?\/[^\s)'"`]+/gu, (match, prefix) => {
    const candidate = match.slice(prefix.length);
    const normalized = candidate.replace(/\\/gu, '/');
    if (normalized.includes('/config/')) {
      return `${prefix}config/...`;
    }
    if (normalized.includes('/state/')) {
      return `${prefix}state/...`;
    }
    if (normalized.includes('/feeds/')) {
      return `${prefix}feeds/...`;
    }
    if (normalized.includes('/build/')) {
      return `${prefix}build/...`;
    }
    return `${prefix}<redacted-path>`;
  });

  return text;
}

export function sanitizeErrorMessage(error, options = {}) {
  const message = error?.message ?? String(error);
  return redactSensitiveText(message, options);
}
