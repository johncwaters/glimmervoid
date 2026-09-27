export interface HealthAnomalies {
  listenerMismatch: boolean;
  orphanPty: boolean;
  destroyedReachable: boolean;
}

export function anomalyCount(anomalies: HealthAnomalies | null | undefined) {
  if (!anomalies) return 0;
  let count = 0;
  if (anomalies.listenerMismatch) count++;
  if (anomalies.orphanPty) count++;
  if (anomalies.destroyedReachable) count++;
  return count;
}

export function shouldShowHealthMonitor(isDebugModeEnabled: boolean, anomalies: HealthAnomalies | null | undefined) {
  return isDebugModeEnabled || anomalyCount(anomalies) > 0;
}
