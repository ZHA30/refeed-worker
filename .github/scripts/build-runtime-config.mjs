import path from 'node:path';
import process from 'node:process';

import { writeRuntimeConfigFromTree } from './lib/config-tree.mjs';

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
  process.stdout.write(
    `compiled ${Object.keys(runtimeConfig).length} group(s) from ${configRoot} into ${outputPath}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
