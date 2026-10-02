function isTelemetryEnabled(settings: unknown) {
  if (typeof settings !== 'object' || settings === null || !('telemetry' in settings)) return false;
  const { telemetry } = settings;
  if (typeof telemetry !== 'object' || telemetry === null || !('enabled' in telemetry)) return false;
  return telemetry.enabled === true;
}

function isForcedOff(settings: unknown) {
  if (typeof settings !== 'object' || settings === null || !('telemetryForcedOff' in settings)) return false;
  return settings.telemetryForcedOff === true;
}

export function shouldShowTelemetryNotice(settings: unknown, isNoticeDismissed: boolean) {
  if (isNoticeDismissed) return false;
  if (isForcedOff(settings)) return false;
  return isTelemetryEnabled(settings);
}
