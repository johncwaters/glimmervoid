import os from 'node:os';

import { SessionSetup } from '../../shared/contracts/session-setup.ts';
import { claudeProjectsDir } from '../../session/core/conversation-history.ts';
import { createSessionSetupFold } from '../../session/core/session-setup-core.ts';
import { openContainedFile } from '../contained-file.ts';

export async function readSessionSetup(transcriptPath: string): Promise<SessionSetup> {
  const opened = await openContainedFile(transcriptPath, claudeProjectsDir(process.env, os.homedir()));
  if (!opened.ok) throw new Error(`transcript refused: ${opened.reason}`);
  const transcript = opened.file.handle;
  const setup = createSessionSetupFold();
  try {
    for await (const line of transcript.readLines()) setup.ingestLine(line);
    return SessionSetup.parse(setup.snapshot());
  } finally {
    await transcript.close();
  }
}
