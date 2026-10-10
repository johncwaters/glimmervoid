import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FEATURE_SURFACE_RULES } from '../public/feature-surfaces-core.ts';
import { isPrimaryViewVisible, refreshViewOnReason, refreshVisibleViews, viewAttentionState, viewAvailabilityFromSettings, viewsInTabOrder } from '../public/view-registry-core.ts';
import type { ViewGate, ViewRefreshReason, VisibleViewState } from '../public/view-registry-core.ts';

const readSource = (relativePath: string) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('settings derive availability from each row and leave subscribed and ungated views alone', () => {
  const views: { view: string; gate?: ViewGate }[] = [
    { view: 'reviews-renamed', gate: { fromSettings: FEATURE_SURFACE_RULES.teamReview } },
    { view: 'usage', gate: { fromSettings: FEATURE_SURFACE_RULES.usage } },
    { view: 'trace', gate: { subscribe: () => assert.fail('settings must not invoke a subscribed gate') } },
    { view: 'settings' },
  ];
  assert.deepEqual(viewAvailabilityFromSettings(views, null), [{ view: views[0], isAvailable: false }, { view: views[1], isAvailable: true }]);
  const enabledViews = viewAvailabilityFromSettings(views, { teamReview: { enabled: true }, usage: { enabled: false } });
  assert.deepEqual(enabledViews, [{ view: views[0], isAvailable: true }, { view: views[1], isAvailable: false }]);
  assert.equal(enabledViews[0].view, views[0]);
});

test('the registry assigns every settings gate exactly once without matching a view name to a key', () => {
  const registrySource = readSource('../public/view-registry.ts');
  const gateNames = [...registrySource.matchAll(/fromSettings: FEATURE_SURFACE_RULES\.([a-zA-Z]+)/g)].map((match) => match[1]);
  assert.deepEqual(gateNames.sort(), Object.keys(FEATURE_SURFACE_RULES).sort());
  const appSource = readSource('../public/app.ts');
  assert.match(appSource, /function setSurfaceAvailable\(viewTab: DashboardView, isAvailable: boolean\)/);
  assert.doesNotMatch(appSource, /Object\.(?:entries|keys)\(surfaces\)|if \(!viewTab\) return/);
});

test('phone visibility ignores a stale desktop selection and desktop visibility ignores a stale phone screen', () => {
  const phone: VisibleViewState = { isPhoneShellActive: true, activeView: 'usage', phoneScreen: 'hooks' };
  assert.equal(isPrimaryViewVisible('usage', phone), false);
  assert.equal(isPrimaryViewVisible('hooks', phone), true);
  assert.equal(isPrimaryViewVisible('hooks', { ...phone, isPhoneShellActive: false }), false);
  assert.equal(isPrimaryViewVisible('usage', { ...phone, isPhoneShellActive: false }), true);
  assert.equal(isPrimaryViewVisible('usage', { ...phone, phoneScreen: null }), false);
});

test('refreshes reach only the visible row, only for a reason it lists in refreshOn, and retain the trigger', () => {
  const refreshes: [string, ViewRefreshReason][] = [];
  const usageReasons: ViewRefreshReason[] = ['shown', 'connected', 'usage-sessions'];
  const hooksReasons: ViewRefreshReason[] = ['shown', 'connected', 'hooks-updated'];
  const views = [
    { view: 'usage', refreshOn: usageReasons, refresh: (reason: ViewRefreshReason) => refreshes.push(['usage', reason]) },
    { view: 'hooks', refreshOn: hooksReasons, refresh: (reason: ViewRefreshReason) => refreshes.push(['hooks', reason]) },
    { view: 'undeclared', refresh: (reason: ViewRefreshReason) => refreshes.push(['undeclared', reason]) },
    { view: 'settings' },
  ];
  const state: VisibleViewState = { isPhoneShellActive: true, activeView: 'usage', phoneScreen: 'hooks' };
  refreshVisibleViews(views, state, 'connected');
  refreshVisibleViews(views, state, 'hooks-updated');
  refreshVisibleViews(views, state, 'usage-sessions');
  refreshVisibleViews(views, state, 'snapshot');
  refreshVisibleViews(views, { ...state, isPhoneShellActive: false }, 'usage-sessions');
  refreshVisibleViews(views, { ...state, isPhoneShellActive: false }, 'hooks-updated');
  refreshVisibleViews(views, { ...state, phoneScreen: 'undeclared' }, 'shown');
  refreshVisibleViews(views, { ...state, phoneScreen: 'settings' }, 'shown');
  assert.deepEqual(refreshes, [['hooks', 'connected'], ['hooks', 'hooks-updated'], ['usage', 'usage-sessions']]);
});

test('a direct refresh honors refreshOn and tolerates a missing row', () => {
  const refreshes: ViewRefreshReason[] = [];
  const shownOnly: ViewRefreshReason[] = ['shown'];
  const view = { refreshOn: shownOnly, refresh: (reason: ViewRefreshReason) => refreshes.push(reason) };
  refreshViewOnReason(view, 'connected');
  refreshViewOnReason(view, 'shown');
  refreshViewOnReason(undefined, 'shown');
  assert.deepEqual(refreshes, ['shown']);
});

test('the registry rows declare the same refresh triggers the dashboard had before the registry', () => {
  const registrySource = readSource('../public/view-registry.ts');
  const reasonsByView = Object.fromEntries([...registrySource.matchAll(/\{ view: '([^']+)',[^\n]*refreshOn: \[([^\]]*)\]/g)].map((match) => [match[1], match[2]]));
  assert.deepEqual(reasonsByView, { usage: "'shown', 'connected', 'usage-sessions'", hooks: "'shown', 'connected', 'hooks-updated'", trace: "'shown'" });
  assert.doesNotMatch(registrySource, /reason !==|onShow/);
});

test('attention keeps boolean dots and the Visions level distinct', () => {
  assert.deepEqual(viewAttentionState(false), { isActive: false, level: null });
  assert.deepEqual(viewAttentionState(true), { isActive: true, level: null });
  assert.deepEqual(viewAttentionState(null), { isActive: false, level: null });
  assert.deepEqual(viewAttentionState('hand'), { isActive: true, level: 'hand' });
  assert.deepEqual(viewAttentionState('findings'), { isActive: true, level: 'findings' });
  assert.deepEqual(viewAttentionState(''), { isActive: true, level: '' });
});

test('tab presentation preserves Focus before Calm without changing the registry navigation order', () => {
  const views = [{ view: 'calm', tabOrder: 1 }, { view: 'focus', tabOrder: 0 }, { view: 'prs' }, { view: 'future-view' }];
  assert.deepEqual(viewsInTabOrder(views).map((view) => view.view), ['focus', 'calm', 'prs', 'future-view']);
  assert.deepEqual(views.map((view) => view.view), ['calm', 'focus', 'prs', 'future-view']);
  assert.equal(viewsInTabOrder(views)[0], views[1]);
});

test('settings connect and broadcast share the fan-out and only the broadcast marks a live change', () => {
  const appSource = readSource('../public/app.ts');
  assert.equal([...appSource.matchAll(/applyDashboardSettings\(msg\.settings/g)].length, 2);
  assert.match(appSource, /applyDashboardSettings\(msg\.settings\);/);
  assert.match(appSource, /'settings-updated':[\s\S]*?applyDashboardSettings\(msg\.settings, \{ isLiveSettingsChange: true \}\)/);
  assert.match(appSource, /function applyDashboardSettings[^\n]+\{\s*applyTerminalSettings\(settings\);\s*applySettingsBroadcast\(settings\);\s*applyVisionsSettings\(settings\);\s*applySurfaceSettings\(settings, \{ isLiveSettingsChange \}\);\s*syncTelemetryBanner\(settings\);/);
  for (const consumer of ['applyTerminalSettings', 'applySettingsBroadcast', 'applyVisionsSettings', 'syncTelemetryBanner']) {
    const references = [...appSource.matchAll(new RegExp(`\\b${consumer}\\(`, 'g'))].length;
    const declarations = [...appSource.matchAll(new RegExp(`\\bfunction ${consumer}\\(`, 'g'))].length;
    assert.equal(references - declarations, 1, `${consumer} has one fan-out call`);
  }
});

test('attention subscriptions, mounts and sidebar policy live on rows rather than parallel view branches', () => {
  const registrySource = readSource('../public/view-registry.ts');
  assert.equal([...registrySource.matchAll(/attention: \{ subscribe:/g)].length, 4);
  assert.match(registrySource, /definition\.attention\.subscribe\(\(attention\) =>/);
  assert.match(registrySource, /actions\.setPhoneAttention\(definition\.view, attention\)/);
  assert.match(registrySource, /dot\.setAttribute\('data-attention', level\)/);
  assert.doesNotMatch(readSource('../public/index.html'), /tab-[a-z]+-activity|class="header-tab"[^>]+ hidden/);
  const appSource = readSource('../public/app.ts');
  assert.match(appSource, /for \(const viewTab of VIEW_TABS\) viewTab\.mount\(viewTab\.el\)/);
  assert.match(appSource, /\?\.attention\?\.acknowledge\(\)/);
  assert.match(appSource, /\?\.shouldHideReviewSidebar === true/);
  assert.doesNotMatch(readSource('../public/style.css'), /body\[data-active-view=/);
});
