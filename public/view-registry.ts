import { el, queryTag } from './dom-helpers.ts';
import { FEATURE_SURFACE_RULES } from './feature-surfaces-core.ts';
import { activateFocusView, deactivateFocusView, mountFocusView } from './focus-view/focus-view.ts';
import { activateZenView, deactivateZenView, mountZenView } from './zen-view/zen-view.ts';
import { applyBenchmarkConnectionState, mountBenchmarkView } from './benchmark-panel.ts';
import { mountHooksView, refreshHooksView, requestHooksReport } from './hooks-panel.ts';
import { applyIssuesConnectionState, mountIssuesView, refreshIssuesViewOnShow } from './github/issues-panel.ts';
import { applyMyPrsConnectionState } from './github/my-prs-panel.ts';
import { acknowledgePrsViewAttention, mountPrsView } from './github/prs-view.ts';
import { acknowledgeRadarAttention, mountRadarView, setRadarActivityCallback, setRadarTraceOpener } from './radar/radar-panel.ts';
import { onDebugModeChanged } from './session-card/card-dom.ts';
import { mountSettingsView } from './settings/settings-panel.ts';
import { applyTeamReviewConnectionState, setTeamReviewActivityCallback } from './github/team-review-panel.ts';
import { applyTraceConnectionState, mountTraceView, openTraceForSession, refreshTraceView } from './trace-panel.ts';
import { acknowledgeUsageAttention, applyUsageConnectionState, mountUsageView, refreshUsageView, requestUsageReport, setUsageActivityCallback } from './usage/usage-panel.ts';
import { acknowledgeVisionsAttention, applyVisionsConnectionState, mountVisionsView, refreshVisionsView, setVisionsActivityCallback } from './visions/visions-panel.ts';
import { viewAttentionState } from './view-registry-core.ts';
import type { PrimaryView, PrimaryViewDefinition, ViewAttention } from './view-registry-core.ts';

interface ViewRegistryActions {
  onRestart: () => void;
  openTerminal: (id: string) => void;
  openPlan: (id: string) => void;
  setPhoneAttention: (view: string, attention: ViewAttention) => void;
}

export interface DashboardView extends PrimaryView<HTMLElement> {
  tab: HTMLButtonElement;
}

export function createDashboardViews(actions: ViewRegistryActions): DashboardView[] {
  const definitions: PrimaryViewDefinition<HTMLElement>[] = [
    { view: 'focus', label: 'Focus', panelClass: 'focus-view', hasOwnPhoneScreen: true, hasPanelChrome: false, hasReviewSidebar: true, mount: () => mountFocusView({ rail: document.getElementById('focus-rail'), center: document.getElementById('focus-center'), resizer: document.getElementById('focus-rail-resizer') }), activate: activateFocusView, deactivate: deactivateFocusView },
    { view: 'zen', label: 'Zen', panelClass: 'zen-view', hasOwnPhoneScreen: true, hasPanelChrome: false, gate: { fromSettings: FEATURE_SURFACE_RULES.zenView }, mount: mountZenView, activate: activateZenView, deactivate: deactivateZenView },
    { view: 'prs', label: 'Reviews', glyph: '\u21c5', panelClass: 'pr-view', gate: { fromSettings: FEATURE_SURFACE_RULES.teamReview }, mount: (panel) => mountPrsView(panel, { openTerminal: actions.openTerminal }), attention: { subscribe: setTeamReviewActivityCallback, acknowledge: acknowledgePrsViewAttention }, onConnectionChange: (isConnected) => {
      applyMyPrsConnectionState(isConnected);
      applyTeamReviewConnectionState(isConnected);
    } },
    { view: 'issues', label: 'Issues', glyph: '#', panelClass: 'issues-view', mount: mountIssuesView, refreshOn: ['shown'], refresh: refreshIssuesViewOnShow, onConnectionChange: applyIssuesConnectionState },
    { view: 'usage', label: 'Usage', glyph: '\u25d4', panelClass: 'usage-view', gate: { fromSettings: FEATURE_SURFACE_RULES.usage }, mount: mountUsageView, attention: { subscribe: setUsageActivityCallback, acknowledge: acknowledgeUsageAttention }, onConnectionChange: applyUsageConnectionState, refreshOn: ['shown', 'connected', 'usage-sessions'], refresh: (reason) => {
      if (reason === 'shown') refreshUsageView();
      requestUsageReport();
    } },
    { view: 'radar', label: 'Radar', glyph: '\u25ce', panelClass: 'radar-view', gate: { fromSettings: FEATURE_SURFACE_RULES.posthog }, mount: mountRadarView, attention: { subscribe: setRadarActivityCallback, acknowledge: acknowledgeRadarAttention } },
    { view: 'visions', label: 'Visions', glyph: '\u25c7', panelClass: 'visions-view', gate: { fromSettings: FEATURE_SURFACE_RULES.visions }, mount: mountVisionsView, attention: { subscribe: setVisionsActivityCallback, acknowledge: () => { acknowledgeVisionsAttention(); refreshVisionsView(); } }, onConnectionChange: applyVisionsConnectionState },
    { view: 'hooks', label: 'Hooks', glyph: '\u25c8', panelClass: 'hooks-view', mount: mountHooksView, refreshOn: ['shown', 'connected', 'hooks-updated'], refresh: (reason) => {
      if (reason === 'shown') refreshHooksView();
      requestHooksReport();
    } },
    { view: 'trace', label: 'Trace', panelClass: 'trace-view', gate: { subscribe: onDebugModeChanged }, mount: mountTraceView, refreshOn: ['shown'], refresh: refreshTraceView, onAvailabilityChange: (isAvailable) => setRadarTraceOpener(isAvailable ? openTraceForSession : null), onConnectionChange: applyTraceConnectionState },
    { view: 'benchmarks', label: 'Bench', panelClass: 'bench-view', gate: { fromSettings: FEATURE_SURFACE_RULES.benchmarks }, mount: mountBenchmarkView, onConnectionChange: applyBenchmarkConnectionState },
    { view: 'settings', label: 'Settings', glyph: '@', panelClass: 'settings-view', hasPanelChrome: false, mount: (panel) => mountSettingsView(panel, { onRestart: actions.onRestart }) },
  ];

  const main = queryTag(document, '#app-main', 'main');
  const views = definitions.map((definition) => {
    const tab = el('button', 'header-tab', definition.label);
    tab.id = `tab-${definition.view}`;
    tab.type = 'button';
    const panelId = `view-${definition.view}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panelId);
    const isSelected = definition.view === 'focus';
    tab.setAttribute('aria-selected', String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    if (definition.glyph) tab.dataset.phoneGlyph = definition.glyph;
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
  queryTag(document, '#header-tabs', 'div').replaceChildren(...views.map((view) => view.tab));
  return views;
}
