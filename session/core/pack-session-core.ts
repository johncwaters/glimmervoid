import path from "node:path";
import { renameSkillFrontmatter } from "../../shared/skill-frontmatter-core.ts";

type PackAgentSkill = { skillName: string; filesByPath: ReadonlyMap<string, Buffer> };
type PackAgentContext = { fileName: string; bytes: Buffer };
type PackAgentContribution = { packName: string; fingerprint: string; context: PackAgentContext | null; skills: readonly PackAgentSkill[] };
type PackAgentFile = { relativePath: string; bytes: Buffer };
type PackAgentLaunch = { contextLines: readonly string[]; claudePluginDirs: readonly string[]; namedSkillDirs: readonly string[] };

const CLAUDE_PLUGIN_FOLDER_NAME = "claude";
const CONTEXT_FOLDER_NAME = "context";
const NAMED_SKILLS_FOLDER_NAME = "named";
const SKILL_FILE_NAME = "SKILL.md";
const FINGERPRINT_PREFIX_LENGTH = 12;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EMPTY_LAUNCH: PackAgentLaunch = Object.freeze({ contextLines: Object.freeze([]), claudePluginDirs: Object.freeze([]), namedSkillDirs: Object.freeze([]) });

function packAgentFolderName(packName: string, fingerprint: string): string {
  return `${packName}-${fingerprint.slice(0, FINGERPRINT_PREFIX_LENGTH)}`;
}

function packNameOfFolder(folderName: string): string | null {
  const separatorIndex = folderName.length - FINGERPRINT_PREFIX_LENGTH - 1;
  if (separatorIndex < 1 || folderName[separatorIndex] !== "-") return null;
  return folderName.slice(0, separatorIndex);
}

function namespacedSkillName(packName: string, skillName: string): string {
  return `${packName}-${skillName}`;
}

function packContextLine(packName: string, contextPath: string): string {
  return `Pack ${packName} context: ${contextPath}. Read it when the task touches what it covers.`;
}

function isContainedRelativePath(relativePath: string): boolean {
  if (relativePath === "" || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return false;
  return relativePath.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasNamedCopy(packName: string, skillName: string): boolean {
  return SKILL_NAME_PATTERN.test(namespacedSkillName(packName, skillName));
}

function skillFiles(packName: string, skill: PackAgentSkill): PackAgentFile[] | { refusal: string } {
  if (!SKILL_NAME_PATTERN.test(skill.skillName)) return { refusal: `the skill name ${skill.skillName} is not lowercase letters, digits and dashes, at most 64 characters` };
  const skillMarkdown = skill.filesByPath.get(SKILL_FILE_NAME);
  if (skillMarkdown === undefined) return { refusal: `the skill ${skill.skillName} has no ${SKILL_FILE_NAME}` };
  const namedSkillName = namespacedSkillName(packName, skill.skillName);
  const isNamed = hasNamedCopy(packName, skill.skillName);
  const files: PackAgentFile[] = [];
  for (const [relativePath, bytes] of skill.filesByPath) {
    if (!isContainedRelativePath(relativePath)) return { refusal: `the skill ${skill.skillName} names a file outside its folder: ${relativePath}` };
    files.push({ relativePath: path.posix.join(CLAUDE_PLUGIN_FOLDER_NAME, "skills", skill.skillName, relativePath), bytes });
    if (!isNamed) continue;
    const namedBytes = relativePath === SKILL_FILE_NAME ? Buffer.from(renameSkillFrontmatter(skillMarkdown.toString("utf8"), namedSkillName)) : bytes;
    files.push({ relativePath: path.posix.join(NAMED_SKILLS_FOLDER_NAME, namedSkillName, relativePath), bytes: namedBytes });
  }
  return files;
}

function planPackAgentFiles(contribution: PackAgentContribution): { files: PackAgentFile[]; warnings: string[] } | { refusal: string } {
  const files: PackAgentFile[] = [];
  const warnings = contribution.skills
    .filter((skill) => !hasNamedCopy(contribution.packName, skill.skillName))
    .map((skill) => `The pack ${contribution.packName} skill ${skill.skillName} reaches no Codex or Kimi session: ${namespacedSkillName(contribution.packName, skill.skillName)} is longer than 64 characters`);
  if (contribution.skills.length > 0) {
    const manifest = { name: contribution.packName, version: contribution.fingerprint.slice(0, FINGERPRINT_PREFIX_LENGTH), description: `Skills from the Glimmervoid pack ${contribution.packName}` };
    files.push({ relativePath: path.posix.join(CLAUDE_PLUGIN_FOLDER_NAME, ".claude-plugin", "plugin.json"), bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  }
  for (const skill of contribution.skills) {
    const planned = skillFiles(contribution.packName, skill);
    if ("refusal" in planned) return planned;
    files.push(...planned);
  }
  if (contribution.context === null) return { files, warnings };
  if (!isContainedRelativePath(contribution.context.fileName) || /[\\/]/.test(contribution.context.fileName)) return { refusal: `the context file name ${contribution.context.fileName} is not a plain file name` };
  files.push({ relativePath: path.posix.join(CONTEXT_FOLDER_NAME, contribution.context.fileName), bytes: contribution.context.bytes });
  return { files, warnings };
}

function packAgentLaunchOf(root: string, contributions: readonly PackAgentContribution[]): PackAgentLaunch {
  if (contributions.length === 0) return EMPTY_LAUNCH;
  const contextLines: string[] = [];
  const claudePluginDirs: string[] = [];
  const namedSkillDirs: string[] = [];
  for (const contribution of contributions) {
    const folder = path.join(root, packAgentFolderName(contribution.packName, contribution.fingerprint));
    if (contribution.skills.length > 0) claudePluginDirs.push(path.join(folder, CLAUDE_PLUGIN_FOLDER_NAME));
    for (const skill of contribution.skills.filter((candidate) => hasNamedCopy(contribution.packName, candidate.skillName))) namedSkillDirs.push(path.join(folder, NAMED_SKILLS_FOLDER_NAME, namespacedSkillName(contribution.packName, skill.skillName)));
    if (contribution.context !== null) contextLines.push(packContextLine(contribution.packName, path.join(folder, CONTEXT_FOLDER_NAME, contribution.context.fileName)));
  }
  return { contextLines, claudePluginDirs, namedSkillDirs };
}

function claudePluginArgs(agentId: string, launch: PackAgentLaunch | null): string[] {
  if (launch === null || agentId !== "claude-code") return [];
  return launch.claudePluginDirs.flatMap((pluginDir) => ["--plugin-dir", pluginDir]);
}

export type { PackAgentContribution, PackAgentFile, PackAgentLaunch };
export { claudePluginArgs, packAgentFolderName, packAgentLaunchOf, packNameOfFolder, planPackAgentFiles };
