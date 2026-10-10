import { activateCalmView, deactivateCalmView, mountCalmView } from './calm/calm-view.ts';
import { el, queryTag } from './dom-helpers.ts';
import { FEATURE_SURFACE_RULES } from './feature-surfaces-core.ts';
import { activateFocusView, deactivateFocusView, mountFocusView } from './focus-view/focus-view.ts';
import { applyBenchmarkConnectionState, mountBenchmarkView } from './benchmark-panel.ts';
import { applyFactoryConnectionState, mountFactoryView } from './factory/factory-view.ts';
import { mountHooksView, refreshHooksView, requestHooksReport } from './hooks-panel.ts';
import { applyIssuesConnectionState, mountIssuesView } from './issues-panel.ts';
import { acknowledgePrsViewAttention, mountPrsView } from './prs-view.ts';
import { acknowledgeRadarAttention, mountRadarView, setRadarActivityCallback, setRadarTraceOpener } from './radar-panel.ts';
import { onDebugModeChanged } from './session-card/card-dom.ts';
import { mountSettingsView } from './settings-panel.ts';
import { setTeamReviewActivityCallback } from './team-review-panel.ts';
import { applyTraceConnectionState, mountTraceView, openTraceForSession, refreshTraceView } from './trace-panel.ts';
import { acknowledgeUsageAttention, mountUsageView, refreshUsageView, requestUsageReport, setUsageActivityCallback } from './usage-panel.ts';
import { acknowledgeVisionsAttention, mountVisionsView, refreshVisionsView, setVisionsActivityCallback } from './visions-panel.ts';
import { viewAttentionState, viewsInTabOrder } from './view-registry-core.ts';
import type { PrimaryView, PrimaryViewDefinition, ViewAttention } from './view-registry-core.ts';

interface ViewRegistryActions {
  onRestart: () => void;
  onConfirmUpdateAndRestart: (proceed: (confirmedSessionIds: string[]) => void) => void;
  openTerminal: (id: string) => void;
  openPlan: (id: string) => void;
  openCalm: () => void;
  setPhoneAttention: (view: string, attention: ViewAttention) => void;
}

export interface DashboardView extends PrimaryView<HTMLElement> {
  tab: HTMLButtonElement;
}

export function createDashboardViews(actions: ViewRegistryActions): DashboardView[] {
  const definitions: PrimaryViewDefinition<HTMLElement>[] = [
    { view: 'calm', label: 'Calm', panelClass: 'calm-view', tabOrder: 1, gate: { fromSettings: FEATURE_SURFACE_RULES.calmLayout }, hasOwnPhoneScreen: true, hasPanelChrome: false, shouldHideReviewSidebar: true, mount: (panel) => mountCalmView(panel, { openTerminal: actions.openTerminal, openPlan: actions.openPlan, openCalm: actions.openCalm }), activate: activateCalmView, deactivate: deactivateCalmView },
    { view: 'focus', label: 'Focus', panelClass: 'focus-view', tabOrder: 0, hasOwnPhoneScreen: true, hasPanelChrome: false, mount: () => mountFocusView({ rail: document.getElementById('focus-rail'), center: document.getElementById('focus-center'), resizer: document.getElementById('focus-rail-resizer') }), activate: activateFocusView, deactivate: deactivateFocusView },
    { view: 'prs', label: 'Reviews', glyph: '\u21c5', panelClass: 'pr-view', gate: { fromSettings: FEATURE_SURFACE_RULES.teamReview }, shouldHideReviewSidebar: true, mount: mountPrsView, attention: { subscribe: setTeamReviewActivityCallback, acknowledge: acknowledgePrsViewAttention } },
    { view: 'issues', label: 'Issues', glyph: '#', panelClass: 'issues-view', mount: mountIssuesView, onConnectionChange: applyIssuesConnectionState },
    { view: 'usage', label: 'Usage', glyph: '\u25d4', panelClass: 'usage-view', gate: { fromSettings: FEATURE_SURFACE_RULES.usage }, mount: mountUsageView, attention: { subscribe: setUsageActivityCallback, acknowledge: acknowledgeUsageAttention }, refreshOn: ['shown', 'connected', 'usage-sessions'], refresh: (reason) => {
      if (reason === 'shown') refreshUsageView();
      requestUsageReport();
    } },
    { view: 'radar', label: 'Radar', glyph: '\u25ce', panelClass: 'radar-view', gate: { fromSettings: FEATURE_SURFACE_RULES.posthog }, mount: mountRadarView, attention: { subscribe: setRadarActivityCallback, acknowledge: acknowledgeRadarAttention } },
    { view: 'visions', label: 'Visions', glyph: '\u25c7', panelClass: 'visions-view', gate: { fromSettings: FEATURE_SURFACE_RULES.visions }, mount: mountVisionsView, attention: { subscribe: setVisionsActivityCallback, acknowledge: () => { acknowledgeVisionsAttention(); refreshVisionsView(); } } },
    { view: 'hooks', label: 'Hooks', glyph: '\u25c8', panelClass: 'hooks-view', mount: mountHooksView, refreshOn: ['shown', 'connected', 'hooks-updated'], refresh: (reason) => {
      if (reason === 'shown') refreshHooksView();
      requestHooksReport();
    } },
    { view: 'trace', label: 'Trace', panelClass: 'trace-view', gate: { subscribe: onDebugModeChanged }, mount: mountTraceView, refreshOn: ['shown'], refresh: refreshTraceView, onAvailabilityChange: (isAvailable) => setRadarTraceOpener(isAvailable ? openTraceForSession : null), onConnectionChange: applyTraceConnectionState },
    { view: 'benchmarks', label: 'Bench', panelClass: 'bench-view', gate: { fromSettings: FEATURE_SURFACE_RULES.benchmarks }, mount: mountBenchmarkView, onConnectionChange: applyBenchmarkConnectionState },
    { view: 'factory', label: 'Factory', panelClass: 'factory-floor', gate: { fromSettings: FEATURE_SURFACE_RULES.factory }, mount: mountFactoryView, onConnectionChange: applyFactoryConnectionState },
    { view: 'settings', label: 'Settings', glyph: '@', panelClass: 'settings-view', hasPanelChrome: false, mount: (panel) => mountSettingsView(panel, { onRestart: actions.onRestart, onConfirmUpdateAndRestart: actions.onConfirmUpdateAndRestart }) },
  ];

  const main = queryTag(document, '#app-main', 'main');
  const views = definitions.map((definition) => {
    const tab = el('button', 'header-tab', definition.label);
    tab.id = `tab-${definition.view}`;
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `view-${definition.view}`);
    const isSelected = definition.view === 'focus';
    tab.setAttribute('aria-selected', String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (definition.glyph) tab.dataset.phoneGlyph = definition.glyph;
    const panelId = `view-${definition.view}`;
    const panel = document.getElementById(panelId) ?? el('section');
    panel.classList.add(definition.panelClass);
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;
    if (!panel.parentElement) main.append(panel);
    tab.hidden = definition.gate !== undefined;
    panel.classList.toggle('view-panel', definition.hasPanelChrome !== false);
    if (definition.attention) {
      const dot = el('span', 'tab-activity');
      dot.id = `tab-${definition.view}-activity`;
      dot.setAttribute('aria-hidden', 'true');
      tab.append(dot);
      definition.attention.subscribe((attention) => {
        const { isActive, level } = viewAttentionState(attention);
        dot.classList.toggle('active', isActive);
        if (level === null) dot.removeAttribute('data-attention');
        if (level !== null) dot.setAttribute('data-attention', level);
        actions.setPhoneAttention(definition.view, attention);
      });
    }
    return { ...definition, tab, el: panel };
  });
  queryTag(document, '#header-tabs', 'div').replaceChildren(...viewsInTabOrder(views).map((view) => view.tab));
  return views;
}
