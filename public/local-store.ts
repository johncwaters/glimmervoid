export function getJSON<Fallback>(key: string, fallback: Fallback): Fallback {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

export function getString(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function setString(key: string, value: string): void {
  try {
    if (value === '') {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, value);
  } catch {
  }
}

export function removeKeysWithPrefix(prefix: string, shouldKeepKey: (key: string) => boolean): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null && key.startsWith(prefix) && !shouldKeepKey(key)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) localStorage.removeItem(key);
  } catch {
  }
}
