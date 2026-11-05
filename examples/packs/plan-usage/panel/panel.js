const WINDOW_LABELS = { fiveHour: '5-hour', sevenDay: '7-day' };
const { element } = window.glimmervoid;

function describeReset(resetsAtMs) {
  if (resetsAtMs === null) return '';
  const minutesLeft = Math.max(0, Math.round((resetsAtMs - Date.now()) / 60000));
  if (minutesLeft < 60) return `resets in ${minutesLeft}m`;
  const hoursLeft = Math.floor(minutesLeft / 60);
  if (hoursLeft < 48) return `resets in ${hoursLeft}h ${minutesLeft % 60}m`;
  return `resets in ${Math.floor(hoursLeft / 24)}d`;
}

function fillClass(percentUsed) {
  if (percentUsed >= 90) return 'fill high';
  if (percentUsed >= 70) return 'fill warn';
  return 'fill';
}

function windowRow(windowKey, usageWindow) {
  const row = element('div', 'window');
  const head = element('div', 'window-head');
  const hasPercent = usageWindow !== null && usageWindow.pct !== null;
  const percentUsed = hasPercent ? Math.min(100, Math.max(0, usageWindow.pct)) : 0;
  head.append(element('span', '', WINDOW_LABELS[windowKey]), element('span', '', hasPercent ? `${Math.round(percentUsed)}%` : 'no data'));
  const track = element('div', 'track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-label', `${WINDOW_LABELS[windowKey]} window`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percentUsed));
  const fill = element('div', fillClass(percentUsed));
  fill.style.width = `${percentUsed}%`;
  track.append(fill);
  row.append(head, track);
  if (usageWindow !== null) row.append(element('div', 'resets', describeReset(usageWindow.resetsAtMs)));
  return row;
}

function vendorCard(planLimit) {
  const card = element('div', 'vendor');
  card.append(element('h2', 'vendor-name', planLimit.vendor), windowRow('fiveHour', planLimit.fiveHour), windowRow('sevenDay', planLimit.sevenDay));
  return card;
}

function renderPlanLimits(planLimits) {
  const summary = document.getElementById('summary');
  const vendors = document.getElementById('vendors');
  summary.textContent = planLimits.length === 0 ? 'No plan usage reported yet.' : `${planLimits.length} plans`;
  vendors.replaceChildren(...planLimits.map(vendorCard));
}

window.glimmervoid.subscribe(['usage', 'theme'], (topic, data) => {
  if (topic === 'hello' && !data.includes('usage')) document.getElementById('summary').textContent = 'This panel was not granted the usage topic.';
  if (topic === 'theme') window.glimmervoid.applyTheme(data);
  if (topic === 'usage') renderPlanLimits(data.planLimits);
});
