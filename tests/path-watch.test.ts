import './helpers/isolate-home.ts';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { watchPath, watchTree } from '../server/path-watch.ts';
import { waitFor, waitForFsWatchToArm } from './helpers/wait-for.ts';

test('watchPath follows a file whose folders do not exist yet, then an editor replacing it by rename', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-path-watch-'));
  const settingsPath = path.join(root, 'later', 'nested', 'settings.json');
  let changeCount = 0;
  const stop = watchPath(settingsPath, () => { changeCount += 1; }, { debounceMs: 20 });
  try {
    await waitForFsWatchToArm();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{"model":"first"}');
    await waitFor(() => changeCount >= 1, 'the change once the file appeared', 2000);

    await waitForFsWatchToArm();
    const countBeforeRename = changeCount;
    const swapPath = `${settingsPath}.tmp`;
    fs.writeFileSync(swapPath, '{"model":"second"}');
    fs.renameSync(swapPath, settingsPath);
    await waitFor(() => changeCount > countBeforeRename, 'the change after the rename-over', 2000);

    await waitForFsWatchToArm();
    const countBeforeSecondRename = changeCount;
    fs.writeFileSync(swapPath, '{"model":"third"}');
    fs.renameSync(swapPath, settingsPath);
    await waitFor(() => changeCount > countBeforeSecondRename, 'the change after a second rename-over', 2000);
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watchTree follows a folder created after the watch starts, down to a file in a new subfolder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-tree-watch-'));
  const skillsFolder = path.join(root, 'skills');
  let changeCount = 0;
  const stop = watchTree(skillsFolder, () => { changeCount += 1; }, { debounceMs: 20 });
  try {
    await waitForFsWatchToArm();
    fs.mkdirSync(skillsFolder);
    await waitFor(() => changeCount >= 1, 'the change once the folder appeared', 2000);

    await waitForFsWatchToArm();
    fs.mkdirSync(path.join(skillsFolder, 'reviewing'));
    await waitForFsWatchToArm();
    const countBeforeSkillFile = changeCount;
    fs.writeFileSync(path.join(skillsFolder, 'reviewing', 'SKILL.md'), '---\nname: reviewing\n---\n');
    await waitFor(() => changeCount > countBeforeSkillFile, 'the change inside the new subfolder', 2000);
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
