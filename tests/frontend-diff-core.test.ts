import test from 'node:test';
import assert from 'node:assert/strict';

const importCore = () => import('../public/sidebar/diff-core.ts');

test('parseUnifiedDiff: empty input returns []', async () => {
  const { parseUnifiedDiff } = await importCore();
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff(null), []);
});

test('parseUnifiedDiff: a modified file yields typed hunk lines and exact counts', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/src/foo.js b/src/foo.js',
    'index 111..222 100644',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -1,3 +1,4 @@',
    ' context one',
    '-removed line',
    '+added line',
    '+second added',
    ' context two',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, 'src/foo.js');
  assert.equal(f.status, 'modified');
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.equal(f.hunks.length, 1);
  assert.equal(f.hunks[0].header, '@@ -1,3 +1,4 @@');
  assert.deepEqual(f.hunks[0].lines, [
    { type: 'context', text: 'context one', oldLineNumber: 1, newLineNumber: 1 },
    { type: 'del', text: 'removed line', oldLineNumber: 2, newLineNumber: null },
    { type: 'add', text: 'added line', oldLineNumber: null, newLineNumber: 2 },
    { type: 'add', text: 'second added', oldLineNumber: null, newLineNumber: 3 },
    { type: 'context', text: 'context two', oldLineNumber: 3, newLineNumber: 4 },
  ]);
});

test('parseHunkHeader: reads both starts, with or without counts', async () => {
  const { parseHunkHeader } = await importCore();
  assert.deepEqual(parseHunkHeader('@@ -12,7 +30,9 @@ function foo()'), { oldStart: 12, newStart: 30 });
  assert.deepEqual(parseHunkHeader('@@ -1 +1 @@'), { oldStart: 1, newStart: 1 });
  assert.deepEqual(parseHunkHeader('@@ -0,0 +1,2 @@'), { oldStart: 0, newStart: 1 });
  assert.equal(parseHunkHeader('@@ nonsense @@'), null);
  assert.equal(parseHunkHeader(' context line'), null);
});

test('parseUnifiedDiff: an added file numbers only the new side', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+line a',
    '+line b',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.deepEqual(f.hunks[0].lines.map((line) => [line.oldLineNumber, line.newLineNumber]), [
    [null, 1],
    [null, 2],
  ]);
});

test('parseUnifiedDiff: a deleted file numbers only the old side', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -4,2 +0,0 @@',
    '-gone one',
    '-gone two',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.deepEqual(f.hunks[0].lines.map((line) => [line.oldLineNumber, line.newLineNumber]), [
    [4, null],
    [5, null],
  ]);
});

test('parseUnifiedDiff: each hunk restarts numbering from its own header', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/multi.js b/multi.js',
    '--- a/multi.js',
    '+++ b/multi.js',
    '@@ -1,3 +1,3 @@',
    ' first context',
    '-first removed',
    '+first added',
    '@@ -40,3 +40,4 @@',
    ' later context',
    '+later added',
    ' trailing context',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.deepEqual(f.hunks[0].lines.map((line) => [line.oldLineNumber, line.newLineNumber]), [
    [1, 1],
    [2, null],
    [null, 2],
  ]);
  assert.deepEqual(f.hunks[1].lines.map((line) => [line.oldLineNumber, line.newLineNumber]), [
    [40, 40],
    [null, 41],
    [41, 42],
  ]);
});

test('parseUnifiedDiff: a no-newline marker carries no line number', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/tail.js b/tail.js',
    '--- a/tail.js',
    '+++ b/tail.js',
    '@@ -1,2 +1,2 @@',
    ' kept',
    '-old tail',
    '\\ No newline at end of file',
    '+new tail',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  const meta = f.hunks[0].lines[2];
  assert.equal(meta.type, 'meta');
  assert.equal(meta.oldLineNumber, null);
  assert.equal(meta.newLineNumber, null);
  assert.deepEqual(f.hunks[0].lines[3], { type: 'add', text: 'new tail', oldLineNumber: null, newLineNumber: 2 });
});

test('parseUnifiedDiff: a new file (git add -N style) is status added', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    'index 000..abc',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+line a',
    '+line b',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'new.js');
  assert.equal(f.status, 'added');
  assert.equal(f.added, 2);
  assert.equal(f.removed, 0);
});

test('parseUnifiedDiff: a deleted file is status deleted', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    'index abc..000',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-gone one',
    '-gone two',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'old.js');
  assert.equal(f.status, 'deleted');
  assert.equal(f.removed, 2);
  assert.equal(f.added, 0);
});

test('parseUnifiedDiff: a rename is status renamed with oldPath', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/old/name.js b/new/name.js',
    'similarity index 95%',
    'rename from old/name.js',
    'rename to new/name.js',
    'index abc..def 100644',
    '--- a/old/name.js',
    '+++ b/new/name.js',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.status, 'renamed');
  assert.equal(f.path, 'new/name.js');
  assert.equal(f.oldPath, 'old/name.js');
});

test('parseUnifiedDiff: a binary file is flagged binary', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/img.png b/img.png',
    'index abc..def 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.binary, true);
  assert.equal(f.path, 'img.png');
});

test('parseUnifiedDiff: handles CRLF line endings', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/f.js b/f.js',
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\r\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.path, 'f.js');
  assert.equal(f.added, 1);
  assert.equal(f.removed, 1);

  assert.equal(f.hunks[0].lines[1].text, 'b');
});

test('parseUnifiedDiff: two files in one diff', async () => {
  const { parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/one.js b/one.js',
    '--- a/one.js',
    '+++ b/one.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/two.js b/two.js',
    '--- a/two.js',
    '+++ b/two.js',
    '@@ -1 +1 @@',
    '-c',
    '+d',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.path), ['one.js', 'two.js']);
});

test('summarizeFiles: rolls up file count and add/remove totals', async () => {
  const { parseUnifiedDiff, summarizeFiles } = await importCore();
  const diff = [
    'diff --git a/one.js b/one.js',
    '--- a/one.js',
    '+++ b/one.js',
    '@@ -1 +1,2 @@',
    '-a',
    '+b',
    '+c',
  ].join('\n');
  const s = summarizeFiles(parseUnifiedDiff(diff));
  assert.deepEqual(s, { files: 1, added: 2, removed: 1 });
  assert.deepEqual(summarizeFiles([]), { files: 0, added: 0, removed: 0 });
});

test('shouldDropDiffCache: drops on merged/none and on parked -> pending-review, keeps otherwise', async () => {
  const { shouldDropDiffCache } = await importCore();

  assert.equal(shouldDropDiffCache('pending-review', 'merged'), true);
  assert.equal(shouldDropDiffCache('parked', 'merged'), true);
  assert.equal(shouldDropDiffCache('parked', 'none'), true);
  assert.equal(shouldDropDiffCache(undefined, 'none'), true);

  assert.equal(shouldDropDiffCache('parked', 'pending-review'), true);

  assert.equal(shouldDropDiffCache('parked', 'merging'), false);
  assert.equal(shouldDropDiffCache('none', 'pending-review'), false);
  assert.equal(shouldDropDiffCache(undefined, 'pending-review'), false);
  assert.equal(shouldDropDiffCache('pending-review', 'pending-review'), false);
  assert.equal(shouldDropDiffCache('parked', 'parked'), false);
  assert.equal(shouldDropDiffCache('merging', 'parked'), false);
});

test('annotationTargetOf: an added line targets the new side at its new line number', async () => {
  const { annotationTargetOf } = await importCore();
  const line = { type: 'add', text: 'added', oldLineNumber: null, newLineNumber: 12 };

  assert.deepEqual(annotationTargetOf({ path: 'a.ts' }, line), { path: 'a.ts', line: 12, side: 'new' });
});

test('annotationTargetOf: a removed line targets the old side at its pre-image line number', async () => {
  const { annotationTargetOf } = await importCore();
  const line = { type: 'del', text: 'removed', oldLineNumber: 7, newLineNumber: null };

  assert.deepEqual(annotationTargetOf({ path: 'a.ts' }, line), { path: 'a.ts', line: 7, side: 'old' });
});

test('annotationTargetOf: a context line targets the new side', async () => {
  const { annotationTargetOf } = await importCore();
  const line = { type: 'context', text: 'kept', oldLineNumber: 3, newLineNumber: 4 };

  assert.deepEqual(annotationTargetOf({ path: 'a.ts' }, line), { path: 'a.ts', line: 4, side: 'new' });
});

test('annotationTargetOf: a meta line and a numberless line cannot be annotated', async () => {
  const { annotationTargetOf } = await importCore();

  assert.equal(annotationTargetOf({ path: 'a.ts' }, { type: 'meta', text: 'No newline', oldLineNumber: null, newLineNumber: null }), null);
  assert.equal(annotationTargetOf({ path: 'a.ts' }, { type: 'del', text: 'removed', oldLineNumber: null, newLineNumber: null }), null);
});

test('annotationTargetOf: every line parsed out of a diff carries the target its gutter implies', async () => {
  const { annotationTargetOf, parseUnifiedDiff } = await importCore();
  const diff = [
    'diff --git a/src/foo.js b/src/foo.js',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -1,2 +1,2 @@',
    ' kept',
    '-gone',
    '+fresh',
  ].join('\n');
  const [file] = parseUnifiedDiff(diff);

  assert.deepEqual(file.hunks[0].lines.map((line) => annotationTargetOf(file, line)), [
    { path: 'src/foo.js', line: 1, side: 'new' },
    { path: 'src/foo.js', line: 2, side: 'old' },
    { path: 'src/foo.js', line: 2, side: 'new' },
  ]);
});

test('annotationKey separates the two diff sections, the two sides and the two lines', async () => {
  const { annotationKey } = await importCore();

  assert.notEqual(annotationKey('committed', 'a.ts', 3, 'new'), annotationKey('uncommitted', 'a.ts', 3, 'new'));
  assert.notEqual(annotationKey('committed', 'a.ts', 3, 'new'), annotationKey('committed', 'a.ts', 3, 'old'));
  assert.notEqual(annotationKey('committed', 'a.ts', 3, 'new'), annotationKey('committed', 'a.ts', 4, 'new'));
  assert.equal(annotationKey('committed', 'a.ts', 3, 'new'), annotationKey('committed', 'a.ts', 3, 'new'));
});

test('staleDraftKeys drops only the drafts of a section whose diff text changed', async () => {
  const { annotationKey, staleDraftKeys } = await importCore();
  const committedKey = annotationKey('committed', 'a.ts', 3, 'new');
  const uncommittedKey = annotationKey('uncommitted', 'b.ts', 7, 'old');
  const keys = [committedKey, uncommittedKey];

  assert.deepEqual(staleDraftKeys(null, { committed: 'x', uncommitted: 'y' }, keys), []);
  assert.deepEqual(
    staleDraftKeys({ committed: 'x', uncommitted: 'y' }, { committed: 'x', uncommitted: 'y' }, keys),
    [],
  );
  assert.deepEqual(
    staleDraftKeys({ committed: 'x', uncommitted: 'y' }, { committed: 'x2', uncommitted: 'y' }, keys),
    [committedKey],
  );
  assert.deepEqual(
    staleDraftKeys({ committed: 'x', uncommitted: 'y' }, { committed: 'x2', uncommitted: '' }, keys),
    keys,
  );
});
