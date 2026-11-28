import { For, flush, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { mountIsland } from '../ui/island.ts';
import { createSyncedSignal } from '../ui/store-signal.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import { AgentCard } from './AgentCard.tsx';
import type { AgentCardActions, AgentCardModel } from './AgentCard.tsx';
import {
  INITIAL_AGENT_CARDS_STATE,
  closeCardMenu,
  pruneAgentCardsState,
  resolvePaintedCards,
  setCardRefusal,
  toggleCardMenu,
  updateCardSize,
} from './agent-card-core.ts';
import type { PaintedAgentCard } from './agent-card-core.ts';
import { areRectListsEqual, computeCardLayouts } from './agent-card-place-core.ts';

export type { AgentCardModel };

export interface AgentCards {
  element: HTMLElement;
  paint(
    models: readonly AgentCardModel[],
    boundsOf: (boxId: string) => Rect | null,
    mapBounds: readonly Rect[],
    camera: Camera,
    fixedAreasOf: () => readonly Rect[],
  ): void;
  place(camera: Camera): void;
}

interface AgentCardsProps {
  host: HTMLElement;
  actions: AgentCardActions;
  onReady: (handle: AgentCards) => void;
}

function AgentCards(props: AgentCardsProps): JSX.Element {
  const paintedSignal = createSyncedSignal<readonly PaintedAgentCard<AgentCardModel>[]>([]);
  const coreStateSignal = createSyncedSignal(INITIAL_AGENT_CARDS_STATE);
  const mapBoundsSignal = createSyncedSignal<readonly Rect[]>([]);
  const fixedAreasReaderSignal = createSyncedSignal<() => readonly Rect[]>(() => []);
  const cameraSignal = createSyncedSignal<Camera | null>(null);
  const viewSizeSignal = createSyncedSignal({ width: 0, height: 0 });

  const cardElementBySessionId = new Map<string, HTMLElement>();
  const sessionIdByCardElement = new Map<Element, string>();
  const shrunkElementBySessionId = new Map<string, HTMLElement>();
  const wireElementBySessionId = new Map<string, SVGPathElement>();

  const applyLayouts = (camera: Camera) => {
    cameraSignal.update(camera);
    const painted = paintedSignal.peek();
    const state = coreStateSignal.peek();
    const { nextPlacementBySessionId, layoutsBySessionId } = computeCardLayouts({
      cards: painted,
      placementBySessionId: state.placementBySessionId,
      cardSizeBySessionId: state.cardSizeBySessionId,
      mapBounds: mapBoundsSignal.peek(),
      mapBoundsRevision: state.mapBoundsRevision,
      viewSize: viewSizeSignal.peek(),
      camera,
      fixedAreas: fixedAreasReaderSignal.peek()(),
    });
    coreStateSignal.update((previous) => ({ ...previous, placementBySessionId: nextPlacementBySessionId }));
    for (const entry of painted) {
      const layout = layoutsBySessionId[entry.sessionId];
      if (!layout) continue;
      const cardEl = cardElementBySessionId.get(entry.sessionId);
      const shrunkEl = shrunkElementBySessionId.get(entry.sessionId);
      const wireEl = wireElementBySessionId.get(entry.sessionId);
      if (cardEl && layout.cardTransform !== null) cardEl.style.transform = layout.cardTransform;
      if (shrunkEl && layout.shrunkTransform !== null) shrunkEl.style.transform = layout.shrunkTransform;
      if (wireEl && layout.wirePath !== null) wireEl.setAttribute('d', layout.wirePath);
    }
  };

  const sizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const [borderBox] = entry.borderBoxSize;
      if (entry.target === props.host) {
        viewSizeSignal.update({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
      const sessionId = sessionIdByCardElement.get(entry.target);
      if (sessionId !== undefined && borderBox && borderBox.inlineSize > 0) {
        coreStateSignal.update((previous) => updateCardSize(previous, sessionId, {
          width: borderBox.inlineSize,
          height: borderBox.blockSize,
        }));
      }
    }
    const camera = cameraSignal.peek();
    if (camera) applyLayouts(camera);
  });

  onSettled(() => {
    sizeObserver.observe(props.host);
    return () => sizeObserver.disconnect();
  });

  const bindCardElement = (sessionId: string, element: HTMLElement) => {
    const previous = cardElementBySessionId.get(sessionId);
    if (previous && previous !== element) {
      sizeObserver.unobserve(previous);
      sessionIdByCardElement.delete(previous);
    }
    cardElementBySessionId.set(sessionId, element);
    sessionIdByCardElement.set(element, sessionId);
    sizeObserver.observe(element);
  };

  const handle: AgentCards = {
    element: props.host,
    paint: (models, boundsOf, mapBounds, camera, fixedAreasOf) => {
      const prevMapBounds = mapBoundsSignal.peek();
      mapBoundsSignal.update(mapBounds);
      fixedAreasReaderSignal.update(() => fixedAreasOf);
      const painted = resolvePaintedCards(models, boundsOf);
      const visibleIds = new Set(painted.map((entry) => entry.sessionId));
      for (const [sessionId, cardEl] of cardElementBySessionId) {
        if (visibleIds.has(sessionId)) continue;
        sizeObserver.unobserve(cardEl);
        sessionIdByCardElement.delete(cardEl);
        cardElementBySessionId.delete(sessionId);
        shrunkElementBySessionId.delete(sessionId);
        wireElementBySessionId.delete(sessionId);
      }
      coreStateSignal.update((previous) => ({
        ...pruneAgentCardsState(previous, visibleIds),
        mapBoundsRevision: areRectListsEqual(prevMapBounds, mapBounds)
          ? previous.mapBoundsRevision
          : previous.mapBoundsRevision + 1,
      }));
      paintedSignal.update(painted);
      flush();
      applyLayouts(camera);
    },
    place: applyLayouts,
  };

  props.onReady(handle);

  return (
    <>
      <svg class="bs-card-wires" aria-hidden="true">
        <For each={paintedSignal.read()} keyed={(entry) => entry.sessionId}>
          {(entry) => (
            <path
              class="bs-card-wire"
              ref={(element) => wireElementBySessionId.set(entry().sessionId, element)}
              data-branch={entry().model.isBranch ? '' : undefined}
              data-hidden={entry().isWireHidden ? '' : undefined}
            />
          )}
        </For>
      </svg>
      <For each={paintedSignal.read()} keyed={(entry) => entry.sessionId}>
        {(entry) => (
          <AgentCard
            entry={entry()}
            isMenuOpen={coreStateSignal.read().openMenuSessionId === entry().sessionId}
            refusalText={coreStateSignal.read().refusalBySessionId[entry().sessionId] ?? null}
            actions={props.actions}
            onToggleMenu={(sessionId) => coreStateSignal.update((previous) => toggleCardMenu(previous, sessionId))}
            onCloseMenu={(sessionId) => coreStateSignal.update((previous) => closeCardMenu(previous, sessionId))}
            onRefusalChange={(sessionId, text) => coreStateSignal.update((previous) => setCardRefusal(
              previous,
              sessionId,
              text,
              new Set(paintedSignal.peek().map((paintedEntry) => paintedEntry.sessionId)),
            ))}
            onBindCardElement={bindCardElement}
            onBindShrunkElement={(sessionId, element) => shrunkElementBySessionId.set(sessionId, element)}
          />
        )}
      </For>
    </>
  );
}

export function mountAgentCardsIsland(
  host: HTMLElement,
  lifecycleHost: HTMLElement,
  actions: AgentCardActions,
): AgentCards {
  let activeHandle: AgentCards | undefined;
  mountIsland(
    host,
    () => (
      <AgentCards
        host={host}
        actions={actions}
        onReady={(readyHandle) => {
          activeHandle = readyHandle;
        }}
      />
    ),
    { lifecycleHost },
  );
  return {
    element: host,
    paint: (...args) => activeHandle?.paint(...args),
    place: (camera) => activeHandle?.place(camera),
  };
}
