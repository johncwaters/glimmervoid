const DASHBOARD_TAB_LOCK_PREFIX = 'glimmervoid-dashboard-tab:';

function holdDashboardTabLock(): void {
  if (!navigator.locks) return;
  const tabLockName = `${DASHBOARD_TAB_LOCK_PREFIX}${crypto.randomUUID()}`;
  void navigator.locks.request(tabLockName, () => new Promise<never>(() => {})).catch(() => {});
}

async function countDashboardTabs(): Promise<number | null> {
  if (!navigator.locks) return null;
  try {
    const snapshot = await navigator.locks.query();
    return (snapshot.held ?? []).filter((lock) => lock.name?.startsWith(DASHBOARD_TAB_LOCK_PREFIX)).length;
  } catch {
    return null;
  }
}

export { countDashboardTabs, holdDashboardTabLock };
