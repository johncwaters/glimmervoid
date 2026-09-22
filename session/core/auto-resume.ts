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
  checkedTranscriptPaths: string[];
}

interface ReportedResumeId {
  currentResumeSessionId: string | null;
  reportedId: string;
  signal: string | null | undefined;
  sessionStartSource: string | null | undefined;
  confidence?: string | null | undefined;
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
  if (!options.resumeSessionId) {
    return { resumeSessionId: null, transcriptPath: null, checkedTranscriptPaths: [] };
  }
  const candidates = transcriptPathCandidates(options);
  const checkedTranscriptPaths: string[] = [];
  for (const candidate of candidates) {
    checkedTranscriptPaths.push(candidate);
    if (!fileExists(candidate)) continue;
    return { resumeSessionId: options.resumeSessionId, transcriptPath: candidate, checkedTranscriptPaths };
  }
  return { resumeSessionId: null, transcriptPath: candidates[0] || null, checkedTranscriptPaths };
}

function shouldAdoptReportedResumeId(
  { currentResumeSessionId, reportedId, signal, sessionStartSource, confidence }: ReportedResumeId,
): boolean {
  if (!currentResumeSessionId) return true;
  if (reportedId === currentResumeSessionId) return false;
  if (String(confidence || "").toLowerCase() === "low") return false;
  if (signal === "session-start") {
    return String(sessionStartSource || "").toLowerCase() === "clear";
  }
  if (signal === "session-end") return false;
  return true;
}

export { pickAutoResume, resolveResumeTarget, shouldAdoptReportedResumeId, RESUME_ID_RE };
export type { AutoResumeConfig, AutoResumeProject, ReportedResumeId };
