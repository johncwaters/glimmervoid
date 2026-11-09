function remoteWatcherUrlOf(configuredUrl: string | undefined, isRemoteListenerEnabled: boolean): string | null {
  if (configuredUrl === undefined) return null;
  if (!isRemoteListenerEnabled) return null;
  return configuredUrl;
}

export { remoteWatcherUrlOf };
