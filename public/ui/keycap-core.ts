export type KeycapTone = 'neutral' | 'accent';

type KeycapDescriptor = {
  className: 'ui-keycap';
  text: string;
  tone?: 'accent';
};

type KeyChordPart =
  | { readonly kind: 'key'; readonly text: string; readonly className: 'ui-keycap' }
  | { readonly kind: 'sep'; readonly text: '+'; readonly className: 'ui-key-chord-sep' };

export function keycapDescriptor(text: string, options: { tone?: KeycapTone } = {}): KeycapDescriptor {
  const tone = options.tone ?? 'neutral';
  return {
    className: 'ui-keycap',
    text,
    tone: tone !== 'neutral' ? tone : undefined,
  };
}

export function keyChordParts(keys: readonly string[]): readonly KeyChordPart[] {
  const parts: KeyChordPart[] = [];
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    if (keyIndex > 0) parts.push({ kind: 'sep', text: '+', className: 'ui-key-chord-sep' });
    parts.push({ kind: 'key', text: keys[keyIndex], className: 'ui-keycap' });
  }
  return parts;
}
