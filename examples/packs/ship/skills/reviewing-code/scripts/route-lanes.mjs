#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const sensitivePathPattern = /(auth|secret|token|credential|crypto|cookie|session|oauth|permission|sandbox|protected|\.env|docker|\.github\/workflows|deploy|infra|stripe|payment|confine|settings\.base|deny)/i
const sensitiveChangedLinePattern = /(admin|forbid|unauthori|permission|child_process|execSync|execFile|spawn\(|\beval\(|innerHTML|dangerouslySet|rm\s+-r|api[_-]?key|bearer|authorization|password|secret|credential|cookie|hmac|encrypt|decrypt|SELECT |INSERT |\.ssh|auth\.json|token)/i
const guaranteePathPattern = /(guard|gate|policy|lease|sandbox|hook|lint|retention|escalat|permission|limit|quota|validate|land|promote|lock|auth|billing|charge)/i
const guaranteeStemPattern = /(deny|denie|refus|reject|block|limit|quota|ceiling|revok|expir|lease|lock|mutex|retry|budget|throttle|cleanup|finally|guard|gate|forbid|allowlist|denylist|timeout|abort|retention|escalat|eligib|must|bypass|enforce|prevent|cancel)/gi
const minGuaranteeStemsForRedteam = 6
const nonCodeExtensions = ['.md', '.json', '.txt', '.yaml', '.yml']

function isCodeFile(filePath) {
  return !nonCodeExtensions.some((extension) => filePath.endsWith(extension))
}

function securityFilesFor(changedFiles, changedLines) {
  const sensitiveFiles = changedFiles.filter((filePath) => sensitivePathPattern.test(filePath))
  if (sensitiveFiles.length > 0) {
    return sensitiveFiles
  }
  if (!sensitiveChangedLinePattern.test(changedLines)) {
    return []
  }
  return changedFiles
}

function redteamFilesFor(codeFiles, changedLines) {
  const guaranteeFiles = codeFiles.filter((filePath) => guaranteePathPattern.test(filePath))
  if (guaranteeFiles.length > 0) {
    return guaranteeFiles
  }
  const guaranteeStemCount = (changedLines.match(guaranteeStemPattern) || []).length
  if (guaranteeStemCount < minGuaranteeStemsForRedteam) {
    return []
  }
  return codeFiles
}

export function selectRuleLanes({ changedFiles, changedLines, allLanes = false }) {
  const filesByLane = { code: changedFiles }
  const codeFiles = changedFiles.filter(isCodeFile)
  const securityFiles = allLanes ? changedFiles : securityFilesFor(changedFiles, changedLines)
  if (securityFiles.length > 0) {
    filesByLane.security = securityFiles
  }
  const redteamFiles = allLanes ? codeFiles : redteamFilesFor(codeFiles, changedLines)
  if (redteamFiles.length > 0) {
    filesByLane.redteam = redteamFiles
  }
  if (codeFiles.length > 0) {
    filesByLane.boundary = codeFiles
  }
  if (allLanes) {
    filesByLane.architecture = changedFiles
  }
  return { lanes: Object.keys(filesByLane), filesByLane }
}

function diffArgumentsOf(reviewCmd) {
  const [program, ...rest] = reviewCmd.trim().split(/\s+/)
  const afterRepo = rest[0] === '-C' ? rest.slice(2) : rest
  if (program !== 'git' || afterRepo[0] !== 'diff') {
    throw new Error(`REVIEW_CMD must be a git diff command, got: ${reviewCmd}`)
  }
  const separatorIndex = afterRepo.indexOf('--')
  const revisions = separatorIndex < 0 ? afterRepo.slice(1) : afterRepo.slice(1, separatorIndex)
  const optionArgument = revisions.find((argument) => argument.startsWith('-'))
  if (optionArgument) {
    throw new Error(`REVIEW_CMD may name revisions and paths only, got: ${optionArgument}`)
  }
  return afterRepo.slice(1)
}

export function readChangedLines(reviewCmd, repoPath) {
  const diffArguments = diffArgumentsOf(reviewCmd)
  const diffText = execFileSync('git', ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-C', repoPath, 'diff', '--no-ext-diff', '--no-textconv', '-U0', '--no-color', ...diffArguments], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  return diffText.split('\n').filter((diffLine) => /^[+-](?![+-]{2})/.test(diffLine)).join('\n')
}

function main() {
  const { values, positionals: changedFiles } = parseArgs({ options: { 'review-cmd': { type: 'string' }, repo: { type: 'string' }, 'all-lanes': { type: 'boolean' } }, allowPositionals: true })
  if (!values['review-cmd'] || !values.repo || changedFiles.length === 0) {
    process.stderr.write('usage: route-lanes.mjs --review-cmd <cmd> --repo <path> [--all-lanes] -- <changed file> ...\n')
    process.exit(2)
  }
  try {
    const changedLines = readChangedLines(values['review-cmd'], values.repo)
    process.stdout.write(`${JSON.stringify(selectRuleLanes({ changedFiles, changedLines, allLanes: Boolean(values['all-lanes']) }))}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main()
}
