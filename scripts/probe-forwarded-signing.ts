import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execFileAsync } from '../server/child-process-safe.ts';
import { parseSshPublicKey } from '../server/core/ssh-signing-core.ts';
import { createSshSigner } from '../server/ssh-signing.ts';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function main(): Promise<number> {
  const publicKey = parseSshPublicKey(process.argv[2] ?? '');
  if (!publicKey) {
    console.error('usage: node scripts/probe-forwarded-signing.ts "<ssh public key line>"');
    return 2;
  }
  const signer = createSshSigner({ env: { ...process.env, SSH_AUTH_SOCK: '' } });
  const agentEnv = await signer.agentEnvFor(publicKey);
  console.log(`agent found by discovery: ${agentEnv?.SSH_AUTH_SOCK ?? 'none'}`);
  const payload = Buffer.from(`tree ${EMPTY_TREE_SHA}\nauthor Probe <probe@example.test> 0 +0000\ncommitter Probe <probe@example.test> 0 +0000\n\nforwarded signing probe\n`);
  const outcome = await signer.signWithAgent({ publicKey, namespace: 'git', payload });
  if (!outcome.ok) {
    console.error(`signing failed: ${outcome.error}`);
    return 1;
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-sign-probe-'));
  try {
    const signaturePath = path.join(workDir, 'payload.sig');
    await fs.writeFile(signaturePath, outcome.signature);
    const checked = await execFileAsync('ssh-keygen', ['-Y', 'check-novalidate', '-n', 'git', '-s', signaturePath], { input: payload.toString('utf8'), encoding: 'utf8' });
    console.log(checked.stdout.trim() || checked.stderr.trim());
    return 0;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
