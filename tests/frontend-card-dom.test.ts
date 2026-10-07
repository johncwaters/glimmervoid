import assert from 'node:assert/strict';
import test from 'node:test';

class CardElement {
  className = '';
  textContent = '';
  title = '';
  dataset: Record<string, string> = {};
  children: CardElement[] = [];
  classList = { toggle() {} };

  append(...children: CardElement[]) { this.children.push(...children); }

  setAttribute() {}

  getAttribute(name: string) { return name === 'title' ? this.title : null; }

  querySelector(selector: string): CardElement | null {
    for (const child of this.children) {
      if (child.className === selector.slice(1)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
}

test('permission chips render resolved guard status and preserve it for recreation', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new CardElement(), getElementById: () => null },
  });
  try {
    const cardDomModulePath = '../public/session-card/card-dom.ts';
    const { buildCardDOM }: {
      buildCardDOM: (id: string, name: string, state: string, options: { skipPerms: boolean; saneYolo?: boolean }) => { card: CardElement };
    } = await import(cardDomModulePath);
    for (const saneYolo of [true, false, undefined]) {
      const { card } = buildCardDOM('session-1', 'Session', 'DORMANT', { skipPerms: true, saneYolo });
      const badge = card.querySelector('.perms-badge');
      assert.equal(badge?.textContent, saneYolo ? 'SANE YOLO' : 'YOLO');
      assert.equal(badge?.getAttribute('title'), saneYolo
        ? 'Skips permission prompts; Sane YOLO blocks catastrophic commands'
        : 'Running with --dangerously-skip-permissions');
      assert.equal(card.dataset.skipPerms, '');
      assert.equal(card.dataset.saneYolo !== undefined, saneYolo === true);
      const recreatedCard = buildCardDOM('session-1', 'Session', 'DORMANT', {
        skipPerms: card.dataset.skipPerms !== undefined,
        saneYolo: card.dataset.saneYolo !== undefined,
      }).card;
      assert.equal(recreatedCard.querySelector('.perms-badge')?.textContent, badge?.textContent);
    }
    for (const saneYolo of [true, false]) {
      const { card } = buildCardDOM('session-1', 'Session', 'DORMANT', { skipPerms: false, saneYolo });
      assert.equal(card.querySelector('.perms-badge'), null);
    }
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    if (!originalDocument) Reflect.deleteProperty(globalThis, 'document');
  }
});

test('a Sane YOLO change after start repaints the existing permission chip in place', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new CardElement(), getElementById: () => null },
  });
  try {
    const cardDomModulePath = '../public/session-card/card-dom.ts';
    const { buildCardDOM, applyCardSaneYolo }: {
      buildCardDOM: (id: string, name: string, state: string, options: { skipPerms: boolean; saneYolo?: boolean }) => { card: CardElement };
      applyCardSaneYolo: (card: CardElement, saneYolo: boolean) => void;
    } = await import(cardDomModulePath);
    const { card } = buildCardDOM('session-1', 'Session', 'INITIALIZING', { skipPerms: true, saneYolo: false });
    const badge = card.querySelector('.perms-badge');
    applyCardSaneYolo(card, true);
    assert.equal(card.querySelector('.perms-badge'), badge);
    assert.equal(badge?.textContent, 'SANE YOLO');
    assert.equal(badge?.title, 'Skips permission prompts; Sane YOLO blocks catastrophic commands');
    assert.equal(card.dataset.saneYolo, '');
    applyCardSaneYolo(card, false);
    assert.equal(badge?.textContent, 'YOLO');
    assert.equal(badge?.title, 'Running with --dangerously-skip-permissions');
    assert.equal('saneYolo' in card.dataset, false);
    const { card: unguardedCard } = buildCardDOM('session-2', 'Session', 'INITIALIZING', { skipPerms: false });
    applyCardSaneYolo(unguardedCard, true);
    assert.equal(unguardedCard.querySelector('.perms-badge'), null);
    assert.equal(unguardedCard.dataset.saneYolo, '');
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    if (!originalDocument) Reflect.deleteProperty(globalThis, 'document');
  }
});
