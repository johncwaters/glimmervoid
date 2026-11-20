export const meta = { name: 'qa-swarm', description: 'Routes a pinned review through the required lanes and converges their findings.', phases: [{ title: 'Review', detail: 'Run the rule-selected lanes at once and any lane the router adds.' }, { title: 'Route', detail: 'Add a lane the rules missed.' }, { title: 'Converge', detail: 'Normalize and converge the lane findings.' }] }

function laneRolePreamble(laneFileName) {
  return `Your role: read ${args.laneDir}/${laneFileName}.md, skip its front matter, and follow the rest as your instructions.\n\n`
}

const laneDefinitions = [
  {
    name: 'code',
    trigger: '',
    spawn: (lanePrompt) => agent(laneRolePreamble('qa-code-reviewer') + lanePrompt, { model: 'opus', label: 'Code review', phase: 'Review' })
  },
  {
    name: 'security',
    trigger: 'the diff touches auth, input handling, crypto, payments, PII, secrets, infrastructure, or destructive operations, or commits anything unsafe to publish, such as token or session tooling, internal hostnames, or account IDs, since every repo is judged as public',
    spawn: (lanePrompt) => agent(laneRolePreamble('security-reviewer') + lanePrompt, { model: 'fable', label: 'Security review', phase: 'Review' })
  },
  {
    name: 'redteam',
    trigger: 'the diff adds or changes a guarantee something must not bypass: a gate, policy, limit, quota, charge, revocation, or a side effect that must always run',
    spawn: (lanePrompt) => agent(laneRolePreamble('redteam-reviewer') + lanePrompt, { model: 'opus', label: 'Red-team review', phase: 'Review' })
  },
  {
    name: 'boundary',
    trigger: 'a changed code file reads from or writes to a peer, worker, cache, shared file, tool, or the environment',
    spawn: (lanePrompt) => agent(laneRolePreamble('boundary-reviewer') + lanePrompt, { model: 'opus', label: 'Boundary review', phase: 'Review' })
  },
  {
    name: 'architecture',
    trigger: 'a changed file makes or reads what another repo or release reads (an id, name pattern, schema, menu, manifest, generator, version check, compat test, shared folder), or writes a status, mode, or phase field',
    spawn: (lanePrompt) => agent(laneRolePreamble('architecture-reviewer') + lanePrompt, { model: 'opus', label: 'Architecture review', phase: 'Review' })
  }
]

const laneDefinitionsByName = new Map(laneDefinitions.map((laneDefinition) => [laneDefinition.name, laneDefinition]))
const selectableLaneNames = laneDefinitions.map((laneDefinition) => laneDefinition.name)

const routerSchema = {
  type: 'object',
  properties: {
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { lane: { type: 'string' }, file: { type: 'string' } },
        required: ['lane', 'file']
      }
    },
    reason: { type: 'string' }
  },
  required: ['lanes', 'reason']
}

const severityRankByName = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const mergeTagPrefixes = ['convergent: ', 'contested: ']
const reviewerTagPattern = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?$/i
const noneFormLineSource = '^[ \\t]*(?:[-*][ \\t]+)?(?:\\((?:none|no findings|nothing|empty|none found)\\)|\\[\\]|none)[ \\t]*$'
const everyNoneFormLine = new RegExp(noneFormLineSource, 'gmi')
const oneNoneFormLine = new RegExp(noneFormLineSource, 'i')
const findingRowStart = /^(?:- )?file: /
const maxFindingsPerLane = args.findingCap === null ? Infinity : args.findingCap ?? 10

function formatLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return '(none)'
  }
  return lines.join('\n')
}

function normalizeFilePath(filePath) {
  const trimmedPath = String(filePath == null ? '' : filePath).trim()
  const repoPathPrefix = args.repoPath ? `${String(args.repoPath).replace(/\/+$/, '')}/` : ''
  if (repoPathPrefix && trimmedPath.startsWith(repoPathPrefix)) {
    return trimmedPath.slice(repoPathPrefix.length).replace(/^(\.\/)+/, '')
  }
  return trimmedPath.replace(/^(\.\/)+/, '')
}

function withoutMergeTagPrefixes(taggedValue) {
  let remainingValue = taggedValue.trim()
  let strippedAPrefix = true
  while (strippedAPrefix) {
    strippedAPrefix = false
    for (const mergeTagPrefix of mergeTagPrefixes) {
      if (remainingValue.startsWith(mergeTagPrefix)) {
        remainingValue = remainingValue.slice(mergeTagPrefix.length).trim()
        strippedAPrefix = true
      }
    }
  }
  return remainingValue
}

function reviewerTagsFrom(reviewerValue) {
  const composedValue = String(reviewerValue == null ? '' : reviewerValue).trim()
  return composedValue.split(/ \+ | vs |; /).map(withoutMergeTagPrefixes).filter((reviewerTag) => reviewerTag !== '')
}

function isAcceptedFindingsHeaderTail(headerTail) {
  const trimmedTail = headerTail.trim()
  if (trimmedTail === '') {
    return true
  }
  return oneNoneFormLine.test(trimmedTail) || findingRowStart.test(trimmedTail)
}

function findingsHeaderMatchesIn(text) {
  return [...text.matchAll(/^[ \t#>*-]*STRUCTURED_FINDINGS:[ \t]*(?![*_]{1,2}[ \t]*$)(?:[*_]{1,2}[ \t]*)?(.*)$/gm)].filter((headerMatch) => isAcceptedFindingsHeaderTail(headerMatch[1]))
}

function summaryHeaderMatchesIn(text) {
  return [...text.matchAll(/^[ \t#>*-]*OVERALL_SUMMARY:[ \t]*(?![*_]{1,2}[ \t]*$)(?:[*_]{1,2}[ \t]*)?(.*)$/gm)]
}

function selectedFindingsHeaderIn(text) {
  const headerMatches = findingsHeaderMatchesIn(text)
  const bareHeaderMatches = headerMatches.filter((headerMatch) => headerMatch[1].trim() === '')
  if (bareHeaderMatches.length === 1) {
    return bareHeaderMatches[0]
  }
  if (bareHeaderMatches.length === 0 && headerMatches.length === 1) {
    return headerMatches[0]
  }
  return null
}

function selectedSummaryHeaderIn(text) {
  const summaryHeaderMatches = summaryHeaderMatchesIn(text)
  if (summaryHeaderMatches.length !== 1) {
    return null
  }
  return summaryHeaderMatches[0]
}

function headerLineCandidatesIn(text, headerName) {
  const headerLines = new RegExp(`^[ \\t#>*_-]*${headerName}[ \\t]*(?::[ \\t]*(?:[*_]{1,2}[ \\t]*)?(?::[ \\t]*)?|[*_]{1,2}[ \\t]*(?::[ \\t]*)?|(?=$))(.*)$`, 'gm')
  return [...text.matchAll(headerLines)]
}

function isStrayHeaderLine(blockLine) {
  return headerLineCandidatesIn(blockLine, 'STRUCTURED_FINDINGS').length > 0 || headerLineCandidatesIn(blockLine, 'OVERALL_SUMMARY').length > 0
}

function withLastHeaderLineColonized(text, headerName, selectedHeaderIn) {
  if (selectedHeaderIn(text)) {
    return text
  }
  const headerLineCandidates = headerLineCandidatesIn(text, headerName)
  for (let candidateIndex = headerLineCandidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const headerLineCandidate = headerLineCandidates[candidateIndex]
    const colonizedHeaderLine = `${headerName}: ${headerLineCandidate[1]}`.trimEnd()
    const colonizedText = `${text.slice(0, headerLineCandidate.index)}${colonizedHeaderLine}${text.slice(headerLineCandidate.index + headerLineCandidate[0].length)}`
    if (selectedHeaderIn(colonizedText)) {
      return colonizedText
    }
  }
  return text
}

function withNoneFormsNormalized(text) {
  return text.replace(everyNoneFormLine, '(none)')
}

function withHeaderColons(text) {
  const withoutWrappers = text
    .replace(/^[ \t]*```[a-z]*[ \t]*$\n?/gm, '')
    .replace(/^[ \t]*END_STRUCTURED_FINDINGS:?[ \t]*\n?/gm, '')
  const withFindingsHeader = withLastHeaderLineColonized(withoutWrappers, 'STRUCTURED_FINDINGS', selectedFindingsHeaderIn)
  const withBothHeaders = withLastHeaderLineColonized(withFindingsHeader, 'OVERALL_SUMMARY', selectedSummaryHeaderIn)
  return withNoneFormsNormalized(withBothHeaders)
}

function blockAndSummaryFrom(normalizedText) {
  const findingsHeader = selectedFindingsHeaderIn(normalizedText)
  const summaryHeader = selectedSummaryHeaderIn(normalizedText)
  if (!findingsHeader || !summaryHeader) {
    return null
  }
  if (summaryHeader.index < findingsHeader.index) {
    return null
  }
  const assembledBlockText = `${findingsHeader[1]}${normalizedText.slice(findingsHeader.index + findingsHeader[0].length, summaryHeader.index)}`
  return {
    blockText: withNoneFormsNormalized(assembledBlockText).trim(),
    summaryText: `${summaryHeader[1]}${normalizedText.slice(summaryHeader.index + summaryHeader[0].length)}`.trim(),
  }
}

function lineFieldIsValid(lineValue) {
  if (lineValue.trim().toLowerCase() === 'general') {
    return true
  }
  return /^[0-9]+$/.test(lineValue.trim()) && Number(lineValue.trim()) > 0
}

function reviewerFieldIsValid(reviewerValue) {
  const reviewerTags = reviewerTagsFrom(reviewerValue)
  if (reviewerTags.length === 0) {
    return false
  }
  return reviewerTags.every((reviewerTag) => reviewerTagPattern.test(reviewerTag))
}

function rawFindingLineFrom(fields) {
  const rawFieldTexts = [`file: ${fields.file}`, `line: ${fields.line}`]
  if (fields.side) {
    rawFieldTexts.push(`side: ${fields.side}`)
  }
  rawFieldTexts.push(`severity: ${fields.severity}`, `reviewer: ${fields.reviewer}`, `body: ${fields.body}`)
  return `- ${rawFieldTexts.join(' | ')}`
}

function parseFindingLine(findingLine) {
  const normalizedLine = findingLine.trim().replace(/^- /, '')
  if (!normalizedLine.startsWith('file: ')) {
    return null
  }
  const bodySeparator = ' | body: '
  const bodySeparatorIndex = normalizedLine.indexOf(bodySeparator)
  if (bodySeparatorIndex < 0) {
    return null
  }
  const fields = { body: normalizedLine.slice(bodySeparatorIndex + bodySeparator.length).trim() }
  if (fields.body === '') {
    return null
  }
  for (const fieldText of normalizedLine.slice(0, bodySeparatorIndex).split(' | ')) {
    const separatorIndex = fieldText.indexOf(': ')
    if (separatorIndex < 1) {
      return null
    }
    fields[fieldText.slice(0, separatorIndex)] = fieldText.slice(separatorIndex + 2).trim()
  }
  if (!fields.file || !fields.line || !fields.severity || !fields.reviewer) {
    return null
  }
  if (!lineFieldIsValid(fields.line) || !reviewerFieldIsValid(fields.reviewer)) {
    return null
  }
  const normalizedSeverity = fields.severity.trim().toUpperCase()
  if (severityRankByName[normalizedSeverity] === undefined) {
    return null
  }
  fields.severity = normalizedSeverity
  fields.file = normalizeFilePath(fields.file)
  const anchorsWholeFile = fields.line.trim().toLowerCase() === 'general'
  if (anchorsWholeFile) {
    fields.line = 'general'
    delete fields.side
  }
  if (!anchorsWholeFile) {
    const declaredSide = (fields.side || 'RIGHT').trim().toUpperCase()
    if (declaredSide !== 'RIGHT' && declaredSide !== 'LEFT') {
      return null
    }
    fields.side = declaredSide
  }
  return { raw: rawFindingLineFrom(fields), fields }
}

function severityRankOf(parsedFinding) {
  return severityRankByName[parsedFinding.fields.severity]
}

function deadLaneResponse() {
  return { hasParseableBlock: false, hasUnparseableRow: false, findings: [], summary: '', hitFindingCap: false }
}

function findingIdentityOf(parsedFinding) {
  const { file, line, side, severity, reviewer } = parsedFinding.fields
  return [file, line, side || '', severity, reviewer].join('|')
}

function findingIdentitiesOf(parsedResponse) {
  return parsedResponse.findings.map(findingIdentityOf).sort().join('\n')
}

function responseAgreedAcrossRepeatedBlocks(laneText, bareFindingsHeaders) {
  const repeatedBlockTexts = bareFindingsHeaders.map((findingsHeader, headerIndex) => {
    const nextHeader = bareFindingsHeaders[headerIndex + 1]
    return laneText.slice(findingsHeader.index, nextHeader ? nextHeader.index : undefined)
  })
  const uncappedResponses = repeatedBlockTexts.map((blockText) => parseSingleBlockResponse(blockText, Infinity))
  if (uncappedResponses.some(isDeadLaneResponse)) {
    return deadLaneResponse()
  }
  const lastIdentities = findingIdentitiesOf(uncappedResponses[uncappedResponses.length - 1])
  if (!uncappedResponses.every((uncappedResponse) => findingIdentitiesOf(uncappedResponse) === lastIdentities)) {
    return deadLaneResponse()
  }
  return parseSingleBlockResponse(repeatedBlockTexts[repeatedBlockTexts.length - 1])
}

function parseLaneResponse(rawLaneText) {
  if (typeof rawLaneText !== 'string' || rawLaneText.trim() === '') {
    return deadLaneResponse()
  }
  const laneText = withHeaderColons(rawLaneText)
  const bareFindingsHeaders = findingsHeaderMatchesIn(laneText).filter((headerMatch) => headerMatch[1].trim() === '')
  if (bareFindingsHeaders.length > 1) {
    return responseAgreedAcrossRepeatedBlocks(laneText, bareFindingsHeaders)
  }
  return parseSingleBlockResponse(laneText)
}

function parseSingleBlockResponse(laneText, findingLimit = maxFindingsPerLane) {
  const deadResponse = deadLaneResponse()
  const splitResponse = blockAndSummaryFrom(laneText)
  if (!splitResponse) {
    return deadResponse
  }
  const summary = splitResponse.summaryText
  if (summary === '') {
    return deadResponse
  }
  const blockText = splitResponse.blockText
  if (blockText === '(none)') {
    return { hasParseableBlock: true, hasUnparseableRow: false, findings: [], summary, hitFindingCap: false }
  }
  const parsedRows = blockText.split('\n').map((blockLine) => blockLine.trim()).filter((blockLine) => blockLine !== '' && !isStrayHeaderLine(blockLine)).map(parseFindingLine)
  const hasUnparseableRow = parsedRows.some((parsedRow) => !parsedRow)
  const rankedFindings = parsedRows.filter(Boolean).sort((leftFinding, rightFinding) => severityRankOf(leftFinding) - severityRankOf(rightFinding))
  const keptFindings = rankedFindings.slice(0, findingLimit)
  return { hasParseableBlock: rankedFindings.length > 0, hasUnparseableRow, findings: keptFindings, summary, hitFindingCap: rankedFindings.length >= findingLimit }
}

function truncatedLaneTagsFrom(summaryText) {
  const truncatedMatch = summaryText.match(/truncated lanes:[ \t]*([^.\n]*)/i)
  if (!truncatedMatch) {
    return null
  }
  const declaredTagText = truncatedMatch[1].trim()
  if (declaredTagText.toLowerCase() === 'none') {
    return new Set()
  }
  return new Set(declaredTagText.split(',').map((laneTag) => laneTag.trim().toLowerCase()).filter((laneTag) => laneTag !== ''))
}

function carriesProof(parsedFinding) {
  return /(?<![a-z0-9])proof[*_]{0,3}\s*:/i.test(parsedFinding.fields.body)
}

function withJudgmentRowsFolded(judgmentText) {
  if (typeof judgmentText !== 'string') {
    return judgmentText
  }
  const splitJudgment = blockAndSummaryFrom(withHeaderColons(judgmentText))
  if (!splitJudgment || splitJudgment.blockText === '(none)') {
    return judgmentText
  }
  const foldedRows = []
  for (const blockLine of splitJudgment.blockText.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !isStrayHeaderLine(line))) {
    if (foldedRows.length === 0 || findingRowStart.test(blockLine)) {
      foldedRows.push(blockLine)
      continue
    }
    foldedRows[foldedRows.length - 1] = `${foldedRows[foldedRows.length - 1]} ${blockLine}`
  }
  return `STRUCTURED_FINDINGS:\n${foldedRows.join('\n')}\n\nOVERALL_SUMMARY:\n${splitJudgment.summaryText}`
}

function findConvergenceValidationFailure(rawJudgmentText, cappedLaneNames, reviewedFileNameSet) {
  if (typeof rawJudgmentText !== 'string') {
    return 'no parseable block'
  }
  const parsedJudgment = parseLaneResponse(rawJudgmentText)
  if (parsedJudgment.hasUnparseableRow) {
    return 'an unparseable row'
  }
  if (!parsedJudgment.hasParseableBlock) {
    return 'no parseable block'
  }
  if (parsedJudgment.findings.some((parsedFinding) => !reviewedFileNameSet.has(parsedFinding.fields.file))) {
    return 'a file outside the reviewed set'
  }
  if (!parsedJudgment.findings.every(carriesProof)) {
    return 'a finding whose body lost its Proof:'
  }
  const declaredTruncatedLaneTags = truncatedLaneTagsFrom(parsedJudgment.summary)
  if (!declaredTruncatedLaneTags) {
    return 'the missing `truncated lanes:` phrase'
  }
  if (!cappedLaneNames.every((cappedLaneName) => declaredTruncatedLaneTags.has(cappedLaneName.toLowerCase()))) {
    return 'the missing `truncated lanes:` phrase naming every required lane'
  }
  return null
}

function buildRouterPrompt(unpickedLaneNames, filesToClassify) {
  const laneTriggerTable = ['| Lane | Triggers when |', '|---|---|', ...unpickedLaneNames.map((laneName) => `| ${laneName} | ${laneDefinitionsByName.get(laneName).trigger} |`)].join('\n')
  return `Scope: decide whether ${formatLines(filesToClassify)} under ${args.reviewCmd} needs a lane the path rules did not pick
Out of scope: reviewing, rating, or reporting defects; spawning or dispatching anything
Definition of done: return the validated router object described below

Read the repo and run the exact REVIEW_CMD. ${proofRunClauseFor(args.reviewCmd)}
Repo path: ${args.repoPath}
Exact REVIEW_CMD: ${args.reviewCmd}
Caller context, verbatim:
${args.context}

Add a lane only when a specific changed file's hunk clearly meets its trigger, naming that file; return an empty lanes array otherwise, plus a one-line reason. Lanes:

${laneTriggerTable}

Return JSON matching this schema:
${JSON.stringify(routerSchema)}`
}

async function routeExtraLanes(unpickedLaneNames, reviewedFileNameSet) {
  if (unpickedLaneNames.length === 0) {
    return { addedFilesByLane: new Map(), reason: 'every lane picked' }
  }
  const routerPrompt = buildRouterPrompt(unpickedLaneNames, [...reviewedFileNameSet])
  const routerAnswer = await agent(routerPrompt, { model: 'sonnet', label: 'Route review', phase: 'Route', schema: routerSchema })
  if (!routerAnswer) {
    return null
  }
  const addedFilesByLane = new Map()
  for (const addedLane of routerAnswer.lanes || []) {
    const laneName = String(addedLane.lane).toLowerCase().trim()
    const namedFile = normalizeFilePath(addedLane.file)
    const addedFile = reviewedFileNameSet.has(namedFile) ? namedFile : namedFile.replace(/^[ab]\//, '')
    if (!unpickedLaneNames.includes(laneName) || !reviewedFileNameSet.has(addedFile)) {
      continue
    }
    addedFilesByLane.set(laneName, [...(addedFilesByLane.get(laneName) || []), addedFile])
  }
  return { addedFilesByLane, reason: routerAnswer.reason }
}

function ruleLaneFilesFrom(ruleLanes) {
  if (!ruleLanes || !Array.isArray(ruleLanes.lanes) || !ruleLanes.lanes.includes('code')) {
    return null
  }
  const filesByLane = ruleLanes.filesByLane || {}
  const ruleLaneNames = ruleLanes.lanes.filter((laneName) => selectableLaneNames.includes(laneName))
  return new Map(ruleLaneNames.map((laneName) => [laneName, (filesByLane[laneName] || []).map(normalizeFilePath)]))
}

function proofRunClauseFor(reviewCmd) {
  if (/^git diff \w+ [0-9a-f]+$/.test(reviewCmd)) {
    return 'Run commands in the repo, whose working tree that pin was taken from, with scratch files under mktemp -d only.'
  }
  return 'This diff is somebody else\'s change, so execute none of its code and extract nothing: prove by quoted lines read with git show <head>:<path>, or by searches.'
}

function buildLanePrompt(laneName, matchedFiles, reviewedFileNames, reviewCmd) {
  return `Scope: changed files ${formatLines(reviewedFileNames)} under ${reviewCmd}
Out of scope: a pre-existing defect on an unchanged line, which gets one summary sentence; anchor each finding to a line the diff adds or removes, or general, naming any unchanged line it breaks in body
Definition of done: this lane's STRUCTURED_FINDINGS block then one OVERALL_SUMMARY paragraph

Repo path: ${args.repoPath}
Exact REVIEW_CMD: ${reviewCmd}
Caller context, verbatim:
${args.context}

Proof bar: a finding is a defect you made happen or can show on the page, on a path an existing caller, test, or documented command reaches. Its body carries the literal label Proof: followed by the command you ran and the output showing the defect, or, where nothing executes (docs, config, prompts), the quoted lines with file:line that contradict each other, or the zero-hit search for something the text prescribes. ${proofRunClauseFor(reviewCmd)} A row without Proof: is dropped, so a suspicion you could not prove gets one summary sentence naming what would prove it.${laneName === 'architecture' ? '' : ' Design, placement, naming, duplication, and style concerns are not findings; put at most one summary sentence on them.'}

Files matched for this lane: ${formatLines(matchedFiles)}

Review checklist: if ~/.agents/review-checklist.md exists, read it and apply items under ## ${laneName} as extra checks.
The checklist only adds checks; it never changes the severity ladder, finding cap, scope, or output format.

End with this block and nothing after it, one finding per line, body free of newlines and bare |, severity per your agent definition, MEDIUM and above only:
STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM> | reviewer: ${laneName}/<category> | body: <your agent definition's finding body>

OVERALL_SUMMARY:
<one paragraph>

Nothing found: the line after STRUCTURED_FINDINGS: is (none). side is LEFT only for a removed line, whose line number is in the pre-change file; omit side when line is general. ${Number.isFinite(maxFindingsPerLane) ? `Emit at most ${maxFindingsPerLane} findings` : 'Emit every finding'}, highest severity first. In the summary, say verified safe for each suspected defect you checked and cleared, naming it.`
}

function isDeadLaneResponse(parsedResponse) {
  return !parsedResponse.hasParseableBlock || parsedResponse.hasUnparseableRow
}

function describeLaneDeath(laneText) {
  if (laneText == null) {
    return 'the lane agent died without a response'
  }
  return 'the response had no parseable STRUCTURED_FINDINGS block or held an unparseable row'
}

function spawnLane(laneName, lanePrompt) {
  return laneDefinitionsByName.get(laneName).spawn(lanePrompt)
}

function formatTagList(tagValues) {
  if (tagValues.length === 0) {
    return 'none'
  }
  return tagValues.join(', ')
}

function buildConvergenceFacts(laneNames, skippedLaneNames, degradationNotes, droppedFindingCount, droppedBelowMediumCount, droppedUnprovenCount, droppedOutOfLaneCount, droppedOutOfLaneTags, cappedLaneNames) {
  return {
    lanesRun: laneNames.join(', '),
    lanesSkipped: formatTagList(skippedLaneNames),
    degraded: degradationNotes.length > 0 ? degradationNotes.join('; ') : 'none',
    droppedFindingCount,
    droppedBelowMediumCount,
    droppedUnprovenCount,
    droppedOutOfLaneCount,
    droppedOutOfLaneTags: formatTagList(droppedOutOfLaneTags),
    truncatedLanes: formatTagList(cappedLaneNames)
  }
}

function formatConvergenceSummary(survivingFindingCount, convergenceFacts) {
  return `${survivingFindingCount} finding(s) survived. Lanes run: ${convergenceFacts.lanesRun}. Lanes skipped: ${convergenceFacts.lanesSkipped}. Degraded: ${convergenceFacts.degraded}. Dropped ${convergenceFacts.droppedFindingCount} finding(s) outside the reviewed-file set. Dropped below MEDIUM: ${convergenceFacts.droppedBelowMediumCount}. Dropped unproven: ${convergenceFacts.droppedUnprovenCount}. Dropped out of lane: ${convergenceFacts.droppedOutOfLaneCount}, tags: ${convergenceFacts.droppedOutOfLaneTags}. truncated lanes: ${convergenceFacts.truncatedLanes}`
}

function buildJudgmentPrompt(convergenceFacts, groupedFindings, laneSummaries, reviewedFileNames, reviewCmd) {
  return `Scope: converge findings for reviewed files ${formatLines(reviewedFileNames)} under ${reviewCmd}
Out of scope: findings outside that reviewed-file set, new review work, verdicts, fixes, and recommendations
Definition of done: one final block opened by the exact line STRUCTURED_FINDINGS: followed by one paragraph opened by the exact line OVERALL_SUMMARY:, and no trailing text

Grouped lane findings:
${JSON.stringify(groupedFindings)}

Lane summaries, supplied only to recognize explicit verified-safe contradictions:
${JSON.stringify(laneSummaries)}

Merge findings on the same file within 5 lines, or plainly the same concern in different words, into one finding tagged convergent: <tag> + <tag>. Keep the highest severity and name the lane that assigned it in the body. A merged body keeps every Proof: its parts carried, verbatim, since the writer re-runs it. Each finding is one line: join a merged body's parts without a line break. Convergence does not raise severity.

A contradiction is one lane asserting a defect and another explicitly verifying it safe. Rule on each from its two positions alone. No ruling available: emit the asserting finding once tagged contested: <asserting lane> vs <disputing lane>, include the disputing reasoning in the body, and end the body with Confidence: low, tiebreak unavailable. A finding both merged and contested carries both tags in one field: convergent: <tag> + <tag>; contested: <asserting lane> vs <disputing lane>.

Return the reviewer output format exactly. The summary is one paragraph carrying exactly this text, with the surviving finding count in place of <count>:

${formatConvergenceSummary('<count>', convergenceFacts)}

When zero findings survive, put the literal (none) on the line after STRUCTURED_FINDINGS:. Do not return a verdict, risk tier, fix, or recommendation.`
}

function isFindingOwnedByLane(parsedFinding, laneName) {
  return reviewerTagsFrom(parsedFinding.fields.reviewer).some((reviewerTag) => {
    const normalizedReviewerTag = reviewerTag.toLowerCase()
    return normalizedReviewerTag === laneName || normalizedReviewerTag.startsWith(`${laneName}/`)
  })
}

function retaggedToLane(parsedFinding, laneName) {
  const retaggedFields = { ...parsedFinding.fields, reviewer: laneName, body: `originally ${parsedFinding.fields.reviewer}: ${parsedFinding.fields.body}` }
  return { raw: rawFindingLineFrom(retaggedFields), fields: retaggedFields }
}

function canConvergeMechanically(survivingFindings, laneSummaries) {
  if (survivingFindings.length === 0) {
    return true
  }
  const findingLaneNames = new Set(survivingFindings.map((survivingFinding) => survivingFinding.lane))
  if (findingLaneNames.size !== 1) {
    return false
  }
  return !laneSummaries.some((laneSummary) => /verified safe/i.test(laneSummary.summary))
}

function buildMechanicalConvergence(survivingFindings, convergenceFacts) {
  const rankedFindingLines = [...survivingFindings]
    .sort((leftFinding, rightFinding) => severityRankOf(leftFinding.finding) - severityRankOf(rightFinding.finding))
    .map((survivingFinding) => survivingFinding.finding.raw)
  const findingsBlock = rankedFindingLines.length > 0 ? rankedFindingLines.join('\n') : '(none)'
  return `STRUCTURED_FINDINGS:\n${findingsBlock}\n\nOVERALL_SUMMARY:\n${formatConvergenceSummary(survivingFindings.length, convergenceFacts)}`
}

if (!args.reviewCmd) {
  return 'No REVIEW_CMD, no run.'
}

if (!Array.isArray(args.changedFiles) || args.changedFiles.length === 0) {
  return 'No changed-file set, no run.'
}

const ruleLaneFiles = ruleLaneFilesFrom(args.ruleLanes)
if (!ruleLaneFiles) {
  return 'No rule lanes, no run.'
}

const reviewedFileNameSet = new Set(args.changedFiles.map(normalizeFilePath))
const reviewedFileNames = [...reviewedFileNameSet]
const resumeSafeRetryId = args.retryAttemptId ?? args.reviewCmd
const degradationNotes = []

async function reviewLane(laneName, matchedFiles) {
  const lanePrompt = buildLanePrompt(laneName, matchedFiles, reviewedFileNames, args.reviewCmd)
  const firstLaneText = await spawnLane(laneName, lanePrompt)
  if (!isDeadLaneResponse(parseLaneResponse(firstLaneText))) {
    return [laneName, firstLaneText]
  }
  log(`Retrying dead lane once: ${laneName}.`)
  return [laneName, await spawnLane(laneName, `Retry attempt id: ${resumeSafeRetryId}\n\nValidation failure reason: ${describeLaneDeath(firstLaneText)}\n\n${lanePrompt}`)]
}

async function reviewRouterAddedLanes() {
  const unpickedLaneNames = selectableLaneNames.filter((laneName) => !ruleLaneFiles.has(laneName))
  const routing = await routeExtraLanes(unpickedLaneNames, reviewedFileNameSet)
  if (!routing) {
    degradationNotes.push('router unavailable; rule lanes only')
    return []
  }
  const { addedFilesByLane, reason } = routing
  log(`Router added lanes: ${addedFilesByLane.size ? formatTagList([...addedFilesByLane.keys()]) : `none (${reason})`}.`)
  return parallel([...addedFilesByLane].map(([laneName, addedFiles]) => () => reviewLane(laneName, addedFiles)))
}

log(`Rule lanes: ${[...ruleLaneFiles.keys()].join(', ')}.`)
phase('Review')
const [ruleLaneTexts, routerAddedLaneTexts] = await parallel([
  () => parallel([...ruleLaneFiles].map(([laneName, matchedFiles]) => () => reviewLane(laneName, matchedFiles))),
  reviewRouterAddedLanes
])
const laneTextsByName = new Map([...(ruleLaneTexts || []), ...(routerAddedLaneTexts || [])].filter(Boolean))
const laneNames = selectableLaneNames.filter((laneName) => ruleLaneFiles.has(laneName) || laneTextsByName.has(laneName))
const parsedResponses = new Map()

for (const laneName of laneNames) {
  const parsedResponse = parseLaneResponse(laneTextsByName.get(laneName))
  if (isDeadLaneResponse(parsedResponse)) {
    return `LANE_DEATH: ${laneName}`
  }
  parsedResponses.set(laneName, parsedResponse)
}

const findingsByFile = new Map()
const survivingFindings = []
let droppedFindingCount = 0
let droppedBelowMediumCount = 0
let droppedUnprovenCount = 0
let droppedOutOfLaneCount = 0
const droppedOutOfLaneTags = new Set()

for (const [laneName, parsedResponse] of parsedResponses) {
  for (const parsedFinding of parsedResponse.findings) {
    if (parsedFinding.fields.severity === 'LOW') {
      droppedBelowMediumCount += 1
      continue
    }
    if (!carriesProof(parsedFinding)) {
      droppedUnprovenCount += 1
      continue
    }
    const isOwnedByLane = isFindingOwnedByLane(parsedFinding, laneName)
    if (!isOwnedByLane && severityRankOf(parsedFinding) > severityRankByName.HIGH) {
      droppedOutOfLaneCount += 1
      droppedOutOfLaneTags.add(parsedFinding.fields.reviewer)
      continue
    }
    const keptFinding = isOwnedByLane ? parsedFinding : retaggedToLane(parsedFinding, laneName)
    const findingFileName = keptFinding.fields.file
    if (!reviewedFileNameSet.has(findingFileName)) {
      droppedFindingCount += 1
      continue
    }
    const findingsForFile = findingsByFile.get(findingFileName) || []
    findingsForFile.push({ lane: laneName, line: keptFinding.raw })
    findingsByFile.set(findingFileName, findingsForFile)
    survivingFindings.push({ lane: laneName, finding: keptFinding })
  }
}

const groupedFindings = [...findingsByFile].map(([file, findings]) => ({ file, findings }))
const cappedLaneNames = [...parsedResponses].filter(([, parsedResponse]) => parsedResponse.hitFindingCap).map(([laneName]) => laneName)
const laneSummaries = [...parsedResponses].map(([laneName, parsedResponse]) => ({ lane: laneName, summary: parsedResponse.summary }))
const skippedLaneNames = selectableLaneNames.filter((laneName) => !laneNames.includes(laneName))

phase('Converge')
const convergenceFacts = buildConvergenceFacts(laneNames, skippedLaneNames, degradationNotes, droppedFindingCount, droppedBelowMediumCount, droppedUnprovenCount, droppedOutOfLaneCount, [...droppedOutOfLaneTags], cappedLaneNames)
if (canConvergeMechanically(survivingFindings, laneSummaries)) {
  const mechanicalConvergence = buildMechanicalConvergence(survivingFindings, convergenceFacts)
  if (findConvergenceValidationFailure(mechanicalConvergence, cappedLaneNames, reviewedFileNameSet)) {
    return 'LANE_DEATH: judgment'
  }
  return mechanicalConvergence
}

const judgmentPrompt = buildJudgmentPrompt(convergenceFacts, groupedFindings, laneSummaries, reviewedFileNames, args.reviewCmd)
const convergedFindings = withJudgmentRowsFolded(await agent(judgmentPrompt, { model: 'opus', label: 'Converge findings', phase: 'Converge' }))
const firstValidationFailure = findConvergenceValidationFailure(convergedFindings, cappedLaneNames, reviewedFileNameSet)
if (!firstValidationFailure) {
  return convergedFindings
}
const retryJudgmentPrompt = `Retry attempt id: ${resumeSafeRetryId}\n\nValidation failure reason: ${firstValidationFailure}\n\n${judgmentPrompt}`
const retriedConvergedFindings = withJudgmentRowsFolded(await agent(retryJudgmentPrompt, { model: 'opus', label: 'Retry converge findings', phase: 'Converge' }))
if (findConvergenceValidationFailure(retriedConvergedFindings, cappedLaneNames, reviewedFileNameSet)) {
  return 'LANE_DEATH: judgment'
}
return retriedConvergedFindings
