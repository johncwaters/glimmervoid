import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTheme, getThemeList } from '../public/theme.ts';

function relativeLuminance(color: string): number {
  const channels = color.slice(1).match(/.{2}/g)?.map((channel) => {
    const intensity = Number.parseInt(channel, 16) / 255;
    if (intensity <= 0.04045) return intensity / 12.92;
    return ((intensity + 0.055) / 1.055) ** 2.4;
  });
  assert.ok(channels && channels.length === 3, color);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test('every theme defines a distinct Monitoring color with visible contrast on its card', (context) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const colors = new Map<string, string>();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: {}, style: { setProperty: (name: string, value: string) => colors.set(name, value) } } },
  });
  context.after(() => {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
      return;
    }
    Reflect.deleteProperty(globalThis, 'document');
  });
  const themes = getThemeList().sort((first, second) => Number(second.id === 'unicorn') - Number(first.id === 'unicorn'));
  for (const theme of themes) {
    colors.clear();
    applyTheme(theme.id);
    const monitoring = colors.get('--state-monitoring');
    assert.ok(monitoring, theme.id);
    assert.ok(colors.get('--state-monitoring-bg'), theme.id);
    for (const [token, color] of colors) {
      if (!token.startsWith('--state-') || token === '--state-monitoring' || !/^#[0-9a-f]{6}$/i.test(color)) continue;
      assert.notEqual(monitoring.toLowerCase(), color.toLowerCase(), `${theme.id}: ${token}`);
    }
    const background = colors.get('--bg-card');
    assert.ok(background, theme.id);
    const monitoringLuminance = relativeLuminance(monitoring);
    const backgroundLuminance = relativeLuminance(background);
    const contrast = (Math.max(monitoringLuminance, backgroundLuminance) + 0.05) / (Math.min(monitoringLuminance, backgroundLuminance) + 0.05);
    assert.ok(contrast >= 4.5, `${theme.id}: contrast ${contrast}`);
  }
});
