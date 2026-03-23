import path from 'node:path';
import process from 'node:process';

import { writeRuntimeConfigFromTree } from './lib/config-tree.mjs';
import { redactSensitiveText } from './lib/redaction.mjs';

function getOption(name, fallback = '') {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function main() {
  const configRoot = getOption('config-root', process.env.REFEED_CONFIG_ROOT ?? path.resolve('config'));
  const outputPath = getOption(
    'output',
    process.env.REFEED_RUNTIME_CONFIG_PATH ?? path.resolve('build', 'config.runtime.json')
  );

  const runtimeConfig = await writeRuntimeConfigFromTree({ configRoot, outputPath });
  process.stdout.write(`compiled ${Object.keys(runtimeConfig).length} group(s) into build/config.runtime.json\n`);
}

main().catch((error) => {
  process.stderr.write(`${redactSensitiveText(error?.message ?? error, {
    configRoot: process.cwd(),
  })}\n`);
  process.exitCode = 1;
});
