import { ANY_COARSE_POINTER_QUERY, COARSE_POINTER_QUERY, decideLayout, decideTouchInput, PHONE_NARROW_QUERY } from './form-factor-core.ts';
import { uiState } from './ui-state-core.ts';

const coarsePointerQuery = window.matchMedia?.(COARSE_POINTER_QUERY);
const narrowWidthQuery = window.matchMedia?.(PHONE_NARROW_QUERY);
const anyCoarsePointerQuery = window.matchMedia?.(ANY_COARSE_POINTER_QUERY);

function evaluateLayout() {
  return decideLayout({
    coarse: !!coarsePointerQuery?.matches,
    narrowWidth: !!narrowWidthQuery?.matches,
  });
}

function stampLayout(layout: string) {
  stampTouchInput(layout);
  if (document.documentElement.dataset.layout === layout) return;
  document.documentElement.dataset.layout = layout;
}

function stampTouchInput(layout: string) {
  const hasTouchInput = decideTouchInput({ layout, hasAnyCoarsePointer: !!anyCoarsePointerQuery?.matches });
  document.documentElement.toggleAttribute('data-touch-input', hasTouchInput);
}

export function initFormFactor() {
  uiState.subscribe((state, changedKeys) => {
    if (!changedKeys.includes('layout')) return;
    stampLayout(state.layout);
  });

  const initialLayout = evaluateLayout();
  stampLayout(initialLayout);
  uiState.dispatch('setLayout', initialLayout);

  const reevaluate = () => uiState.dispatch('setLayout', evaluateLayout());
  coarsePointerQuery?.addEventListener?.('change', reevaluate);
  narrowWidthQuery?.addEventListener?.('change', reevaluate);
  anyCoarsePointerQuery?.addEventListener?.('change', () => stampTouchInput(uiState.snapshot().layout));
  return initialLayout;
}

export function isPhoneLayout() {
  return uiState.snapshot().layout === 'phone';
}

export function onLayoutChange(notify: (layout: string) => void) {
  return uiState.subscribe((state, changedKeys) => {
    if (!changedKeys.includes('layout')) return;
    notify(state.layout);
  });
}
