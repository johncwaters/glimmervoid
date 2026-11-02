import path from "node:path";

import { CONVERSATION_ID_PATTERN } from "../../shared/contracts/session.ts";
import { encodeProjectDir } from "./conversation-history.ts";

const RESUME_ID_RE = CONVERSATION_ID_PATTERN;
const AUTO_RESUME_IDLE_CUTOFF_MS = 24 * 60 * 60 * 1000;
const AUTO_CONTINUE_PROMPT = "Glimmervoid restarted while you were working and resumed this conversation. This is not a new request from the user: carry on with the task you were working on. Any tool call, background command, monitor or subagent that was running was stopped and its outcome is unknown, so check the current state, such as files, git status and running processes, before relying on it or repeating it, and start again any background work the task still needs. Do not recap or ask for confirmation. If the task was already finished, say so in one line.";

interface ResumeTargetOptions {
  resumeSessionId: string | null;
  transcriptPath: string | null;
  projectsDirs: readonly string[];
  cwds: readonly string[];
  isTranscriptRemote?: boolean;
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
  wasWorking?: boolean;
  lastWorkedAt?: number;
  resumeSessionId?: string | null;
}

interface AutoResumeConfig {
  autoResume?: boolean;
  [key: string]: unknown;
}

function hasBeenIdleTooLong(project: AutoResumeProject, nowMs: number): boolean {
  if (project.wasWorking === true) return false;
  if (typeof project.lastWorkedAt !== "number") return false;
  return nowMs - project.lastWorkedAt > AUTO_RESUME_IDLE_CUTOFF_MS;
}

function pickAutoResume(
  projects: readonly AutoResumeProject[] | null | undefined,
  config: AutoResumeConfig | null | undefined,
  nowMs: number,
): string[] {
  if (!Array.isArray(projects)) return [];
  if (config && config.autoResume === false) return [];
  const picked: string[] = [];
  for (const project of projects) {
    if (!project || !project.wasActive) continue;
    if (!project.resumeSessionId) continue;
    if (hasBeenIdleTooLong(project, nowMs)) continue;
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

function findTranscriptForConversation(
  { resumeSessionId, projectsDirs }: { resumeSessionId: string; projectsDirs: readonly string[] },
  fileExists: (transcriptPath: string) => boolean,
  listProjectDirs: (projectsDir: string) => string[],
): string | null {
  if (!RESUME_ID_RE.test(resumeSessionId)) return null;
  const transcriptFileName = `${resumeSessionId}.jsonl`;
  for (const projectsDir of projectsDirs) {
    for (const projectDir of listProjectDirs(projectsDir)) {
      const candidate = path.join(projectsDir, projectDir, transcriptFileName);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveResumeTarget(
  options: ResumeTargetOptions,
  fileExists: (transcriptPath: string) => boolean,
  listProjectDirs?: (projectsDir: string) => string[],
): ResumeTarget {
  if (!options.resumeSessionId) {
    return { resumeSessionId: null, transcriptPath: null, checkedTranscriptPaths: [] };
  }
  if (options.isTranscriptRemote === true) {
    return { resumeSessionId: options.resumeSessionId, transcriptPath: null, checkedTranscriptPaths: [] };
  }
  const candidates = transcriptPathCandidates(options);
  const checkedTranscriptPaths: string[] = [];
  for (const candidate of candidates) {
    checkedTranscriptPaths.push(candidate);
    if (!fileExists(candidate)) continue;
    return { resumeSessionId: options.resumeSessionId, transcriptPath: candidate, checkedTranscriptPaths };
  }
  if (listProjectDirs) {
    const found = findTranscriptForConversation(
      { resumeSessionId: options.resumeSessionId, projectsDirs: options.projectsDirs },
      fileExists,
      listProjectDirs,
    );
    if (found) return { resumeSessionId: options.resumeSessionId, transcriptPath: found, checkedTranscriptPaths };
    for (const projectsDir of options.projectsDirs) {
      checkedTranscriptPaths.push(path.join(projectsDir, "*", `${options.resumeSessionId}.jsonl`));
    }
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

function isConversationReplacedAtStartup(
  { hasPromptSinceSpawn, currentResumeSessionId, reportedId, sessionStartSource }: { hasPromptSinceSpawn: boolean; currentResumeSessionId: string | null; reportedId: string; sessionStartSource: unknown },
): boolean {
  if (!hasPromptSinceSpawn) return false;
  if (String(sessionStartSource || "").toLowerCase() !== "startup") return false;
  return !!currentResumeSessionId && reportedId !== currentResumeSessionId;
}

function resumePromptFor(project: AutoResumeProject | undefined): string | null {
  return project?.wasWorking === true ? AUTO_CONTINUE_PROMPT : null;
}

export { findTranscriptForConversation, isConversationReplacedAtStartup, pickAutoResume, resolveResumeTarget, resumePromptFor, shouldAdoptReportedResumeId, AUTO_CONTINUE_PROMPT, RESUME_ID_RE };
