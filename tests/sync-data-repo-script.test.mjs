import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test('sync-data-repo script copies state and feeds back into the checked out data repository', async () => {
  const script = await readFile(
    path.join(process.cwd(), '.github', 'scripts', 'sync-data-repo.sh'),
    'utf8'
  );

  assert.match(script, /source_state_dir="\$\{1:-state\}"/u);
  assert.match(script, /source_feed_dir="\$\{2:-dist-feed\}"/u);
  assert.match(script, /target_checkout_dir="\$\{3:-data-repo\}"/u);
  assert.match(script, /source_readme_file="\$\{5:-\}"/u);
  assert.match(script, /target_state_dir="\$\{target_checkout_dir\}\/state"/u);
  assert.match(script, /target_feed_dir="\$\{target_checkout_dir\}\/feeds"/u);
  assert.match(script, /target_readme_file="\$\{target_checkout_dir\}\/README\.md"/u);
  assert.match(script, /rm -rf "\$\{target_state_dir\}"/u);
  assert.match(script, /rm -rf "\$\{target_feed_dir\}"/u);
  assert.match(script, /git add state feeds README\.md/u);
  assert.match(script, /git push origin HEAD/u);
});
