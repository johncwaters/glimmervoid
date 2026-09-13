import path from "node:path";

import { encodeProjectDir } from "./conversation-history.ts";

const RESUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

interface ResumeTargetOptions {
  resumeSessionId: string | null;
  transcriptPath: string | null;
  projectsDirs: readonly string[];
  cwds: readonly string[];
}

interface ResumeTarget {
  resumeSessionId: string | null;
  transcriptPath: string | null;
}

interface AutoResumeProject {
  id: string;
  wasActive?: boolean;
  resumeSessionId?: string | null;
}

interface AutoResumeConfig {
  autoResume?: boolean;
  [key: string]: unknown;
}

function pickAutoResume(
  projects: readonly AutoResumeProject[] | null | undefined,
  config?: AutoResumeConfig | null,
): string[] {
  if (!Array.isArray(projects)) return [];
  if (config && config.autoResume === false) return [];
  const picked: string[] = [];
  for (const project of projects) {
    if (!project || !project.wasActive) continue;
    if (!project.resumeSessionId) continue;
    picked.push(project.id);
  }
  return picked;
}

function transcriptPathCandidates(
  { resumeSessionId, transcriptPath, projectsDirs, cwds }: ResumeTargetOptions,
): string[] {
  const candidates: string[] = [];
  const transcriptFileName = `${resumeSessionId}.jsonl`;
  if (transcriptPath && path.basename(transcriptPath) === transcriptFileName) {
    candidates.push(transcriptPath);
  }
  for (const projectsDir of projectsDirs) {
    for (const cwd of cwds) {
      candidates.push(path.join(projectsDir, encodeProjectDir(cwd), transcriptFileName));
    }
  }
  return Array.from(new Set(candidates));
}

function resolveResumeTarget(
  options: ResumeTargetOptions,
  fileExists: (transcriptPath: string) => boolean,
): ResumeTarget {
  if (!options.resumeSessionId) return { resumeSessionId: null, transcriptPath: null };
  const candidates = transcriptPathCandidates(options);
  const existingTranscriptPath = candidates.find((candidate) => fileExists(candidate));
  if (!existingTranscriptPath) {
    return { resumeSessionId: null, transcriptPath: candidates[0] || null };
  }
  return { resumeSessionId: options.resumeSessionId, transcriptPath: existingTranscriptPath };
}

export { pickAutoResume, resolveResumeTarget, RESUME_ID_RE };
export type { AutoResumeConfig, AutoResumeProject };
