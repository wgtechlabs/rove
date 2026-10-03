import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('release keywords recognize scoped breaking commits without promoting ordinary changes', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/build-flow.yml', import.meta.url),
    'utf8',
  );
  const keywords = /^\s+release-major-keywords: '([^'\r\n]+)'$/m.exec(
    workflow,
  )?.[1];
  assert.ok(
    keywords,
    'Declare the Clean Commit breaking syntax for the release detector.',
  );
  for (const [message, expected] of [
    ['🔧 update! (storage): adopt postgresql and redis (#8)', 'major'],
    ['🔧 update!: change the storage contract', 'major'],
    ['🔒 security! (auth): require a new credential format', 'major'],
    ['🔧 update (auth): guard session deletion', 'none'],
    ['📦 new: add a channel', 'none'],
    ['📖 docs: explain update! (storage): syntax', 'none'],
    [
      '🔧 update (storage): change configuration\n\nBREAKING CHANGE: new connection URLs are required.',
      'major',
    ],
  ]) {
    // The pinned release action interprets each keyword as a Bash regular expression.
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      IFS=',' read -ra keywords <<< "$MAJOR_KEYWORDS"
      for keyword in "\${keywords[@]}"; do
        if [[ "$MESSAGE" =~ $keyword ]]; then printf major; exit 0; fi
      done
      printf none
    `,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, MAJOR_KEYWORDS: keywords, MESSAGE: message },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, message);
  }
});
