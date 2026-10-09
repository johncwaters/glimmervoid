import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { runKnowledgeGraphCli } from '../knowledge-graph/cli.ts';
import { BrowserConfig } from '../shared/contracts/config.ts';
import { execFileSync } from './child-process-safe.ts';
import { decideConfigPath, glimmervoidHomeDir } from './core/config-path-core.ts';
import { errorMessage } from './core/text-core.ts';
import { resolvePackageBin } from './runtime-paths.ts';

const COHERENCE_TIMEOUT_MS = 30_000;
const COHERENCE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const COHERENCE_REFUSE_EXIT_STATUS = 2;
const CoherenceRefusalExit = z.looseObject({ status: z.literal(COHERENCE_REFUSE_EXIT_STATUS), stdout: z.string().min(1) });

const KnowledgeGraphGate = z.looseObject({ knowledgeGraph: BrowserConfig.shape.knowledgeGraph });

const KNOWLEDGE_GRAPH_DISABLED_MESSAGE = 'glimmervoid kg is experimental and off. Turn on Settings > Lanes > Knowledge graph, or set knowledgeGraph.enabled in config.json.';

type KnowledgeGraphGateDecision = { isEnabled: boolean; loadError: string | null };

function decideKnowledgeGraphGate(configPath: string | null): KnowledgeGraphGateDecision {
  if (!configPath) return { isEnabled: false, loadError: null };
  try {
    const parsed = KnowledgeGraphGate.safeParse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    return { isEnabled: parsed.success && parsed.data.knowledgeGraph?.enabled === true, loadError: null };
  } catch (error) {
    return { isEnabled: false, loadError: `Could not load ${configPath}: ${errorMessage(error)}` };
  }
}

function runBundledCoherence(repo: string, commandArguments: readonly string[]): string {
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  if (!coherenceCliPath) throw new Error('Could not resolve the coherence CLI');
  try {
    return execFileSync(process.execPath, [coherenceCliPath, ...commandArguments], {
      cwd: repo,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8',
      timeout: COHERENCE_TIMEOUT_MS,
      maxBuffer: COHERENCE_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const refusalExit = CoherenceRefusalExit.safeParse(error);
    if (!refusalExit.success) throw error;
    return refusalExit.data.stdout;
  }
}

export function runKnowledgeGraphCommand(commandArguments: string[]): number {
  const homeDirectory = glimmervoidHomeDir(os.homedir(), process.env);
  const decidedConfig = decideConfigPath({ env: process.env, homeDir: homeDirectory }, (candidate) => fs.existsSync(candidate));
  const gate = decideKnowledgeGraphGate(decidedConfig.path);
  if (gate.loadError) {
    console.error(`kg: ${gate.loadError}`);
    return 1;
  }
  if (!gate.isEnabled) {
    console.error(KNOWLEDGE_GRAPH_DISABLED_MESSAGE);
    return 1;
  }
  return runKnowledgeGraphCli(commandArguments, {
    defaultDatabaseDirectory: path.join(homeDirectory, 'knowledge-graph'),
    runCoherence: runBundledCoherence,
    writeOutput: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  });
}
