const element = (...args) => window.glimmervoid.element(...args);

const NEON_PALETTE = ['#ff2bd6', '#ffe53b', '#2bf0ff', '#3bff7a'];
const OCEAN_PALETTE = ['#3b82f6', '#22d3ee', '#8b5cf6', '#60a5fa', '#a78bfa'];
const MIDDLE_DOT = String.fromCharCode(0xb7);
const LIFE_CELL_PX = 9;
const LIFE_STEP_MS = 140;
const LIFE_STALE_GENERATIONS = 24;
const LIFE_SEED_DENSITY = 0.22;
const RAIN_STEP_MS = 33;
const SPLASH_LIFETIME_STEPS = 18;
const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;
const MAX_MERGED_ROWS = 10;
const UPDATED_TICK_MS = 30 * 1000;

const COLUMNS = [
  { id: 'repo', width: '9%' }, { id: 'status', width: '10%' }, { id: 'ci', width: '8.5%' }, { id: 'number', width: '7%' },
  { id: 'title', width: '19.5%' }, { id: 'reviews', width: '9.5%' }, { id: 'activity', width: '5.5%' }, { id: 'age', width: '4%' },
  { id: 'when', width: '6.5%' }, { id: 'size', width: '8%' }, { id: 'cc', width: '3.5%' }, { id: 'merge', width: '9%' },
];

const SECTIONS = {
  inReview: { titleHeader: 'In review', reviewsHeader: 'Reviews', whenHeader: 'Upd', emptyText: 'Nothing in review', ambient: false },
  queued: { titleHeader: 'Merge queue', reviewsHeader: 'Queue says', whenHeader: 'Since', emptyText: 'Nothing in the merge queue', ambient: false },
  merged: { titleHeader: 'Recently merged', reviewsHeader: '', whenHeader: 'Merged', emptyText: 'Nothing merged recently', ambient: true },
};

function pickIndex(length) {
  return Math.floor(Math.random() * length);
}

function sizeCanvas(canvas) {
  const pixelRatio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  const context = canvas.getContext('2d');
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { context, width, height };
}

function createLife(width, height) {
  const columns = Math.max(1, Math.floor(width / LIFE_CELL_PX));
  const rows = Math.max(1, Math.floor(height / LIFE_CELL_PX));
  let cells = new Uint8Array(columns * rows);
  let nextCells = new Uint8Array(columns * rows);
  const neighborCounts = new Uint8Array(NEON_PALETTE.length + 1);
  const populationHistory = [];

  function seed() {
    for (let index = 0; index < cells.length; index++) cells[index] = Math.random() < LIFE_SEED_DENSITY ? 1 + pickIndex(NEON_PALETTE.length) : 0;
    populationHistory.length = 0;
  }

  function nextCell(column, row) {
    neighborCounts.fill(0);
    let liveNeighbors = 0;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      const neighborRow = (row + rowOffset + rows) % rows;
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        if (rowOffset === 0 && columnOffset === 0) continue;
        const colorIndex = cells[neighborRow * columns + ((column + columnOffset + columns) % columns)];
        if (colorIndex === 0) continue;
        liveNeighbors++;
        neighborCounts[colorIndex]++;
      }
    }
    const current = cells[row * columns + column];
    if (current !== 0) return liveNeighbors === 2 || liveNeighbors === 3 ? current : 0;
    if (liveNeighbors !== 3) return 0;
    let dominantColorIndex = 1;
    for (let colorIndex = 2; colorIndex < neighborCounts.length; colorIndex++) {
      if (neighborCounts[colorIndex] > neighborCounts[dominantColorIndex]) dominantColorIndex = colorIndex;
    }
    return dominantColorIndex;
  }

  function isStale(population) {
    populationHistory.push(population);
    if (populationHistory.length > LIFE_STALE_GENERATIONS) populationHistory.shift();
    if (population < cells.length * 0.03) return true;
    if (populationHistory.length < LIFE_STALE_GENERATIONS) return false;
    return Math.max(...populationHistory) - Math.min(...populationHistory) <= 2;
  }

  function step() {
    let population = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const colorIndex = nextCell(column, row);
        nextCells[row * columns + column] = colorIndex;
        if (colorIndex !== 0) population++;
      }
    }
    [cells, nextCells] = [nextCells, cells];
    if (isStale(population)) seed();
  }

  function draw(context) {
    context.clearRect(0, 0, width, height);
    for (let index = 0; index < cells.length; index++) {
      if (cells[index] === 0) continue;
      context.fillStyle = NEON_PALETTE[cells[index] - 1];
      context.fillRect((index % columns) * LIFE_CELL_PX, Math.floor(index / columns) * LIFE_CELL_PX, LIFE_CELL_PX - 1, LIFE_CELL_PX - 1);
    }
  }

  seed();
  return { step, draw, stepMs: LIFE_STEP_MS };
}

function createRain(width, height) {
  const dropCount = Math.max(4, Math.round(width / 9));
  const newDrop = (canStartInView) => ({
    x: Math.random() * width,
    y: canStartInView ? Math.random() * height : -Math.random() * height,
    length: 6 + Math.random() * 12,
    speed: 1.2 + Math.random() * 2.6,
    color: OCEAN_PALETTE[pickIndex(OCEAN_PALETTE.length)],
  });
  const drops = Array.from({ length: dropCount }, () => newDrop(true));
  const splashes = [];

  function step() {
    for (const [index, drop] of drops.entries()) {
      drop.y += drop.speed;
      if (drop.y - drop.length < height) continue;
      splashes.push({ x: drop.x, color: drop.color, age: 0 });
      drops[index] = newDrop(false);
    }
    for (const splash of splashes) splash.age += 1;
    while (splashes.length > 0 && splashes[0].age > SPLASH_LIFETIME_STEPS) splashes.shift();
  }

  function draw(context) {
    context.clearRect(0, 0, width, height);
    context.lineWidth = 1.5;
    context.globalAlpha = 0.85;
    for (const drop of drops) {
      context.strokeStyle = drop.color;
      context.beginPath();
      context.moveTo(drop.x, drop.y - drop.length);
      context.lineTo(drop.x, drop.y);
      context.stroke();
    }
    for (const splash of splashes) {
      context.fillStyle = splash.color;
      context.globalAlpha = 1 - splash.age / SPLASH_LIFETIME_STEPS;
      for (const direction of [-1, 0, 1]) context.fillRect(splash.x + direction * splash.age * 0.7, height - 2 - (splash.age % 4), 1.5, 1.5);
    }
    context.globalAlpha = 1;
  }

  return { step, draw, stepMs: RAIN_STEP_MS };
}

const SIMULATIONS = { life: createLife, rain: createRain };

function startAmbient(canvas, kind) {
  const { context, width, height } = sizeCanvas(canvas);
  const simulation = SIMULATIONS[kind](width, height);
  simulation.draw(context);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  let frameRequest = 0;
  let lastStepAt = 0;
  const tick = (now) => {
    frameRequest = requestAnimationFrame(tick);
    if (now - lastStepAt < simulation.stepMs) return;
    lastStepAt = now;
    simulation.step();
    simulation.draw(context);
  };
  frameRequest = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frameRequest);
}

function formatAge(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ageSince(timestamp) {
  const milliseconds = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp ?? '');
  return Number.isFinite(milliseconds) ? formatAge(Date.now() - milliseconds) : '';
}

function repoName(fullName) {
  return fullName.split('/').pop();
}

function collectPullRequests(groups) {
  const pullRequestsByKey = new Map();
  for (const group of groups) {
    for (const item of group.items) {
      if (item.source === 'mine') pullRequestsByKey.set(item.pr.key, item.pr);
    }
  }
  pruneMergeStates(pullRequestsByKey);
  const all = [...pullRequestsByKey.values()];
  const byNewest = (field) => (left, right) => Date.parse(right[field] ?? '') - Date.parse(left[field] ?? '');
  return {
    inReview: all.filter((pr) => pr.state === 'OPEN' && !pr.isInMergeQueue).sort(byNewest('updatedAt')),
    queued: all.filter((pr) => pr.state === 'OPEN' && pr.isInMergeQueue).sort((left, right) => (left.mergeQueuePosition ?? Infinity) - (right.mergeQueuePosition ?? Infinity)),
    merged: all.filter((pr) => pr.state === 'MERGED').sort(byNewest('mergedAt')).slice(0, MAX_MERGED_ROWS),
  };
}

function pill(text, tone) {
  return element('span', tone ? `pill ${tone}` : 'pill', text);
}

function statusPill(pr) {
  if (pr.isDraft) return pill('Draft');
  if (pr.reviewDecision === 'APPROVED') return pill('Approved', 'good');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return pill('Changes requested', 'bad');
  return pill('Review required');
}

const CI_PILLS = { SUCCESS: ['CI passed', 'good'], FAILURE: ['CI failing', 'bad'], ERROR: ['CI failing', 'bad'], PENDING: ['CI running', 'warn'], EXPECTED: ['CI running', 'warn'] };

function ciPill(pr) {
  const entry = CI_PILLS[pr.checks.state];
  return entry ? pill(entry[0], entry[1]) : null;
}

function reviewsText(pr) {
  if (pr.unresolvedThreads > 0) return [`${pr.unresolvedThreads} open thread${pr.unresolvedThreads === 1 ? '' : 's'}`, 'warn-text'];
  if (pr.approvals > 0) return [`${pr.approvals} approved`, 'good-text'];
  return ['', null];
}

function queueSaysText(pr) {
  if (pr.mergeQueueFailure) return [pr.mergeQueueFailure.message, 'bad-text'];
  if (pr.isMergeQueueHeldForRepairPush) return ['held for a repair push', 'warn-text'];
  if (pr.mergeQueuePosition) return [`position ${pr.mergeQueuePosition}`, null];
  return ['queued', null];
}

function recentActivityCount(pr) {
  return pr.threads.filter((thread) => Date.now() - Date.parse(thread.lastActivityAt) < RECENT_ACTIVITY_MS).length;
}

function sizeCell(cell, pr) {
  if (pr.additions === undefined || pr.deletions === undefined) return;
  cell.append(element('span', 'add', `+${pr.additions}`), element('span', 'del', `-${pr.deletions}`));
}

const mergeStateByKey = new Map();
const FAILING_CHECK_STATES = new Set(['FAILURE', 'ERROR']);

function isMergeable(pr) {
  if (pr.state !== 'OPEN' || pr.isDraft || pr.isInMergeQueue) return false;
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return false;
  if (pr.checks.failing.length > 0 || FAILING_CHECK_STATES.has(pr.checks.state)) return false;
  return pr.stage === 'ready';
}

function pruneMergeStates(pullRequestsByKey) {
  for (const [key, mergeState] of mergeStateByKey) {
    const pr = pullRequestsByKey.get(key);
    const isStillTheArmedHead = pr !== undefined && pr.headRefOid === mergeState.headRefOid;
    if (isStillTheArmedHead && (mergeState.isBusy || isMergeable(pr))) continue;
    mergeStateByKey.delete(key);
  }
}

const MERGE_OUTCOME_TEXT = { queued: 'Added to the merge queue', merged: 'Merged', 'auto-merge': 'Auto-merge turned on', unconfirmed: 'Sent; GitHub has not confirmed yet' };

async function sendMerge(pr, armedHeadRefOid) {
  mergeStateByKey.set(pr.key, { headRefOid: armedHeadRefOid, isBusy: true, isConfirming: false, statusText: 'Merging' });
  render();
  const answer = await window.glimmervoid.act({ type: 'my-pr-merge', repo: pr.repo, number: pr.number, headRefOid: armedHeadRefOid });
  const isMerged = answer.ok && answer.result?.ok !== false;
  const statusText = isMerged ? (MERGE_OUTCOME_TEXT[answer.result?.kind] ?? 'Sent') : (answer.result?.error ?? answer.error ?? 'Refused');
  mergeStateByKey.set(pr.key, { headRefOid: armedHeadRefOid, isBusy: false, isConfirming: false, statusText: answer.timedOut ? 'No answer yet; check before trying again' : statusText });
  render();
}

function setMergeState(pr, isConfirming) {
  mergeStateByKey.set(pr.key, { headRefOid: pr.headRefOid, isBusy: false, isConfirming, statusText: null });
  render();
}

function actionButton(label, onClick, isDisabled) {
  const button = element('button', null, label);
  button.type = 'button';
  button.disabled = isDisabled;
  button.addEventListener('click', onClick);
  return button;
}

function mergeCell(cell, pr) {
  if (!isMergeable(pr)) return;
  const mergeState = mergeStateByKey.get(pr.key) ?? { isBusy: false, isConfirming: false, statusText: null };
  const wrapper = element('div', 'merge-cell');
  wrapper.append(actionButton('Add to queue', () => setMergeState(pr, true), mergeState.isBusy || mergeState.isConfirming));
  if (mergeState.isConfirming) wrapper.append(actionButton('Confirm', () => sendMerge(pr, mergeState.headRefOid), false), actionButton('Cancel', () => setMergeState(pr, false), false));
  if (mergeState.statusText) wrapper.append(element('span', 'merge-status', mergeState.statusText));
  cell.append(wrapper);
}

function textCell(text, className) {
  return element('td', className ?? null, text);
}

function pullRequestRow(sectionId, pr) {
  const row = element('tr');
  const isMerged = sectionId === 'merged';
  const statusCell = element('td');
  const ciCell = element('td');
  if (!isMerged) statusCell.append(statusPill(pr));
  const ci = isMerged ? null : ciPill(pr);
  if (ci) ciCell.append(ci);
  const numberCell = element('td');
  numberCell.append(element('span', 'num', `#${pr.number}`));
  const [sideText, sideTone] = sectionId === 'queued' ? queueSaysText(pr) : sectionId === 'inReview' ? reviewsText(pr) : ['', null];
  const activityCount = recentActivityCount(pr);
  const whenValue = { inReview: pr.updatedAt, queued: pr.stageSinceMs, merged: pr.mergedAt }[sectionId];
  const sizeTd = element('td');
  sizeCell(sizeTd, pr);
  const ccText = !isMerged && pr.reviewItems.length > 0 ? String(pr.reviewItems.length) : '';
  const mergeTd = element('td', 'merge');
  if (sectionId === 'inReview') mergeCell(mergeTd, pr);
  const titleCell = textCell(pr.title, 'title');
  titleCell.title = pr.title;
  row.append(
    textCell(repoName(pr.repo), 'dim'), statusCell, ciCell, numberCell, titleCell,
    textCell(sideText, sideTone), textCell(activityCount > 0 ? `${activityCount} new` : '', 'info-text'),
    textCell(ageSince(pr.createdAt), 'dim'), textCell(ageSince(whenValue), isMerged ? 'when-merged' : 'dim'),
    sizeTd, textCell(ccText, 'warn-text'), mergeTd,
  );
  return row;
}

function headerRow(section) {
  const labels = ['Repo', 'Status', 'CI', 'PR', section.titleHeader, section.reviewsHeader, 'Activity', 'Age', section.whenHeader, 'Size', 'CC', 'Merge'];
  const row = element('tr');
  row.append(...labels.map((label) => element('th', null, label)));
  return row;
}

function sectionTable(sectionId, pullRequests) {
  const section = SECTIONS[sectionId];
  const wrapper = element('section', 'section');
  wrapper.dataset.section = sectionId;
  const table = element('table');
  const columnGroup = element('colgroup');
  for (const column of COLUMNS) {
    const columnElement = element('col');
    columnElement.style.width = column.width;
    columnGroup.append(columnElement);
  }
  const head = element('thead');
  head.append(headerRow(section));
  const body = element('tbody');
  if (pullRequests.length === 0) {
    const emptyRow = element('tr');
    const emptyCell = element('td', 'empty', section.emptyText);
    emptyCell.colSpan = COLUMNS.length;
    emptyRow.append(emptyCell);
    body.append(emptyRow);
  }
  body.append(...pullRequests.map((pr) => pullRequestRow(sectionId, pr)));
  table.append(columnGroup, head, body);
  wrapper.append(table);
  return wrapper;
}

let stopAmbients = [];

function overlayAmbient(wrapper, firstCell, lastCell, kind, label) {
  const wrapperBox = wrapper.getBoundingClientRect();
  const firstBox = firstCell.getBoundingClientRect();
  const lastBox = lastCell.getBoundingClientRect();
  const overlay = element('div', `ambient ${kind}`);
  Object.assign(overlay.style, {
    left: `${firstBox.left - wrapperBox.left}px`, top: `${firstBox.top - wrapperBox.top}px`,
    width: `${lastBox.right - firstBox.left}px`, height: `${lastBox.bottom - firstBox.top}px`,
  });
  const canvas = element('canvas');
  overlay.append(canvas, element('span', 'ambient-label', label));
  wrapper.append(overlay);
  stopAmbients.push(startAmbient(canvas, kind));
}

function layoutAmbients() {
  for (const stop of stopAmbients) stop();
  stopAmbients = [];
  for (const overlay of document.querySelectorAll('.ambient')) overlay.remove();
  const wrapper = document.querySelector('[data-section="merged"]');
  const rows = wrapper ? [...wrapper.querySelectorAll('tbody tr')].filter((row) => row.cells.length === COLUMNS.length) : [];
  if (rows.length === 0) return;
  const columnIndex = (id) => COLUMNS.findIndex((column) => column.id === id);
  const firstRow = rows[0];
  const lastRow = rows.at(-1);
  overlayAmbient(wrapper, firstRow.cells[columnIndex('status')], lastRow.cells[columnIndex('ci')], 'life', `life ${MIDDLE_DOT} neon`);
  overlayAmbient(wrapper, firstRow.cells[columnIndex('cc')], lastRow.cells[columnIndex('merge')], 'rain', `rain ${MIDDLE_DOT} ocean`);
}

let latestGroups = null;
let lastUpdateAt = null;

function renderUpdated() {
  document.getElementById('updated').textContent = lastUpdateAt === null ? '' : `updated ${formatAge(Date.now() - lastUpdateAt)} ago`;
}

function render() {
  if (latestGroups === null) return;
  const pullRequests = collectPullRequests(latestGroups);
  document.getElementById('counts').textContent = `${pullRequests.inReview.length} in review, ${pullRequests.queued.length} queued, ${pullRequests.merged.length} merged`;
  document.getElementById('sheet').replaceChildren(...Object.keys(SECTIONS).map((sectionId) => sectionTable(sectionId, pullRequests[sectionId])));
  renderUpdated();
  layoutAmbients();
}

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(layoutAmbients);
}).observe(document.body);

setInterval(renderUpdated, UPDATED_TICK_MS);

window.glimmervoid.subscribe(['reviews', 'theme'], (topic, data) => {
  if (topic === 'theme') window.glimmervoid.applyTheme(data);
  if (topic !== 'reviews') return;
  latestGroups = data.groups;
  lastUpdateAt = Date.now();
  render();
});
