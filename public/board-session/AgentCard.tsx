import { createEffect, createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createChatActivity } from '../chat/chat-activity.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import { stringDetailOf } from '../chat/chat-page.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { MENU_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { Button } from '../ui/Button.tsx';
import { Pressable } from '../ui/Pressable.tsx';
import { createSyncedSignal } from '../ui/store-signal.ts';
import {
  ACCOUNT_TEXT,
  CARET_ICON_PATH,
  CLOSE_TEXT,
  FLAG_ICON_PATH,
  MENU_TEXT,
  PICK_AGENT_TEXT,
  RESTART_TEXT,
  cardDisplayOf,
  faceAriaLabelOf,
  faceClassNamesOf,
  parseChatCardAnswer,
  shouldCloseMenuOnEscape,
  shrunkAriaLabelOf,
} from './agent-card-core.ts';
import type { AgentCardCoreModel, PaintedAgentCard } from './agent-card-core.ts';
import { AgentWaits } from './AgentWaits.tsx';
import type { AgentWaits as AgentWaitsHandle } from './AgentWaits.tsx';

export interface AgentCardModel extends AgentCardCoreModel {
  waits: AgentWaitsHandle;
}

export interface AgentCardActions {
  address(model: AgentCardModel): void;
  restart(sessionId: string): void;
  switchAccount(sessionId: string): void;
  pickAgent(sessionId: string): void;
  close(sessionId: string): Promise<string | null>;
  toggleOpened(sessionId: string): void;
  toggleRepoMenu(card: HTMLElement, repoButton: HTMLButtonElement): void;
  answer(sessionId: string, cardId: string, action: string, value: string): void;
}

interface AgentCardProps {
  entry: PaintedAgentCard<AgentCardModel>;
  isMenuOpen: boolean;
  refusalText: string | null;
  actions: AgentCardActions;
  onToggleMenu: (sessionId: string) => void;
  onCloseMenu: (sessionId: string) => void;
  onRefusalChange: (sessionId: string, refusalText: string | null) => void;
  onBindCardElement: (sessionId: string, element: HTMLElement) => void;
  onBindShrunkElement: (sessionId: string, element: HTMLElement) => void;
}

function stopBoardGestures(element: HTMLElement): void {
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
}

function bindAgentFaceMark(
  readMark: () => { agentId: string | null; name: string },
): (element: HTMLButtonElement) => void {
  let faceElement: HTMLButtonElement | undefined;
  createEffect(
    () => readMark(),
    ({ agentId, name }) => {
      if (faceElement) paintAgentMark(faceElement, agentId, name);
    },
  );
  return (element) => {
    faceElement = element;
    const { agentId, name } = readMark();
    paintAgentMark(element, agentId, name);
  };
}

function bindMenuButtonAria(readIsOpen: () => boolean): (element: HTMLButtonElement) => void {
  let buttonElement: HTMLButtonElement | undefined;
  createEffect(
    () => readIsOpen(),
    (isOpen) => {
      buttonElement?.setAttribute('aria-expanded', String(isOpen));
    },
  );
  return (element) => {
    buttonElement = element;
    element.setAttribute('aria-haspopup', 'menu');
    element.setAttribute('aria-expanded', String(readIsOpen()));
  };
}

function createBoundCardActivity(
  readActivity: () => { phase: ChatPhase; beat: ActivityBeat | null },
): HTMLElement {
  const activity = createChatActivity('plain');
  const shownBeatSignal = createSyncedSignal<ActivityBeat | null>(null);
  createEffect(
    () => readActivity(),
    ({ phase, beat }) => {
      activity.setPhase(phase);
      if (beat !== null && beat !== shownBeatSignal.peek()) activity.beat([beat]);
      shownBeatSignal.update(beat);
    },
  );
  return activity.element;
}

function bindCardShell(
  readSessionId: () => string,
  readIsMenuOpen: () => boolean,
  onAnswer: (sessionId: string, cardId: string, action: string, value: string) => void,
  onCloseMenu: (sessionId: string) => void,
  onBindElement: (sessionId: string, element: HTMLElement) => void,
): (element: HTMLElement) => void {
  return (element) => {
    stopBoardGestures(element);
    element.addEventListener('chat-card', (event) => {
      const detail = parseChatCardAnswer(
        stringDetailOf(event, 'cardId'),
        stringDetailOf(event, 'action'),
        stringDetailOf(event, 'value'),
      );
      if (detail !== null) onAnswer(readSessionId(), detail.cardId, detail.action, detail.value);
    });
    element.addEventListener('keydown', (event) => {
      if (shouldCloseMenuOnEscape(event.key, readIsMenuOpen())) onCloseMenu(readSessionId());
    });
    element.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      onCloseMenu(readSessionId());
    });
    onBindElement(readSessionId(), element);
  };
}

export function AgentCard(props: AgentCardProps): JSX.Element {
  let cardElement: HTMLElement | undefined;
  let repoButtonElement: HTMLButtonElement | undefined;

  const display = createMemo(() => cardDisplayOf(props.entry.model, props.isMenuOpen, props.refusalText));
  const faceRef = bindAgentFaceMark(() => ({ agentId: props.entry.model.agentId, name: props.entry.model.name }));
  const shrunkFaceRef = bindAgentFaceMark(() => ({ agentId: props.entry.model.agentId, name: props.entry.model.name }));
  const menuButtonRef = bindMenuButtonAria(() => display().isMenuOpen);
  const activityElement = createBoundCardActivity(() => ({ phase: props.entry.model.phase, beat: props.entry.model.beat }));
  const cardRef = bindCardShell(
    () => props.entry.sessionId,
    () => display().isMenuOpen,
    (sessionId, cardId, action, value) => props.actions.answer(sessionId, cardId, action, value),
    (sessionId) => props.onCloseMenu(sessionId),
    (sessionId, element) => {
      cardElement = element;
      props.onBindCardElement(sessionId, element);
    },
  );

  const handleCloseBranch = () => {
    const sessionId = props.entry.sessionId;
    props.onCloseMenu(sessionId);
    props.onRefusalChange(sessionId, null);
    void props.actions.close(sessionId).then((errorText) => {
      props.onRefusalChange(sessionId, errorText);
    });
  };

  return (
    <>
      <section
        ref={cardRef}
        class="bs-card"
        data-session-id={props.entry.sessionId}
        data-phase={props.entry.model.phase}
        data-main={props.entry.model.isMain ? '' : undefined}
        data-branch={props.entry.model.isBranch ? '' : undefined}
        data-flagged={display().isFlagged ? '' : undefined}
        data-failed={display().isFailed ? '' : undefined}
        data-asking={display().isAsking ? '' : undefined}
        aria-label={props.entry.model.name}
        hidden={props.entry.isCardShrunk}
      >
        <div class="bs-card-head">
          <span class="bs-card-face-slot">
            <Pressable
              ref={faceRef}
              class={faceClassNamesOf(props.entry.model)}
              data-action="board-session-address-face"
              aria-label={faceAriaLabelOf(props.entry.model.name)}
              onClick={() => props.actions.address(props.entry.model)}
            />
          </span>
          <span class="bs-card-name" hidden={display().isNameHidden}>
            {props.entry.model.name}
          </span>
          <Pressable
            ref={(element) => {
              repoButtonElement = element;
              element.setAttribute('aria-haspopup', 'menu');
              element.setAttribute('aria-expanded', 'false');
            }}
            class="bs-card-repo"
            data-action="board-session-repo"
            hidden={display().isRepoButtonHidden}
            onClick={() => {
              if (cardElement && repoButtonElement) props.actions.toggleRepoMenu(cardElement, repoButtonElement);
            }}
          >
            <span class="bs-card-repo-name">{props.entry.model.repoLabel ?? ''}</span>
            {createLineIcon(CARET_ICON_PATH, '1.5')}
          </Pressable>
          <Button
            ref={menuButtonRef}
            variant="icon"
            size="small"
            label={MENU_TEXT}
            icon={createLineIcon(MENU_ICON_PATH, '1.5')}
            action="board-session-agent-menu"
            hidden={display().isMoreButtonHidden}
            onClick={() => props.onToggleMenu(props.entry.sessionId)}
          />
        </div>
        {activityElement}
        <p class="bs-card-digest bs-card-misfit" role="status" hidden={display().isMisfitHidden}>
          {createLineIcon(FLAG_ICON_PATH, '1.5')}
          <span class="bs-card-misfit-text">{props.entry.model.misfit ?? ''}</span>
        </p>
        <p class="bs-card-digest bs-card-failure" role="status" hidden={display().isFailureHidden}>
          {props.entry.model.failure ?? ''}
        </p>
        <Button
          variant="primary"
          size="small"
          label={PICK_AGENT_TEXT}
          action="board-session-pick-agent"
          hidden={display().isPickAgentHidden}
          onClick={() => props.actions.pickAgent(props.entry.sessionId)}
        />
        <p class="bs-card-digest" hidden={display().isDigestHidden}>
          {props.entry.model.digest ?? ''}
        </p>
        <p class="bs-card-digest bs-card-refusal" role="status" hidden={display().isRefusalHidden}>
          {display().refusalText}
        </p>
        <div class="bs-card-approvals-slot">
          <AgentWaits waits={props.entry.model.waits} />
        </div>
        <div class="bs-menu bs-card-menu" role="menu" hidden={!display().isMenuOpen}>
          <Pressable
            class="bs-menu-item"
            role="menuitem"
            data-action="board-session-agent-restart"
            onClick={() => {
              props.onCloseMenu(props.entry.sessionId);
              props.actions.restart(props.entry.sessionId);
            }}
          >
            <span class="bs-menu-name">{RESTART_TEXT}</span>
          </Pressable>
          <Pressable
            class="bs-menu-item"
            role="menuitem"
            data-action="board-session-agent-account"
            onClick={() => {
              props.onCloseMenu(props.entry.sessionId);
              props.actions.switchAccount(props.entry.sessionId);
            }}
          >
            <span class="bs-menu-name">{ACCOUNT_TEXT}</span>
          </Pressable>
          <Pressable
            class="bs-menu-item"
            role="menuitem"
            data-action="board-session-agent-close"
            hidden={display().isCloseItemHidden}
            onClick={handleCloseBranch}
          >
            <span class="bs-menu-name">{CLOSE_TEXT}</span>
          </Pressable>
        </div>
      </section>
      <div
        ref={(element) => {
          stopBoardGestures(element);
          props.onBindShrunkElement(props.entry.sessionId, element);
        }}
        class="bs-card-shrunk"
        data-session-id={props.entry.sessionId}
        data-flagged={display().isFlagged ? '' : undefined}
        data-failed={display().isFailed ? '' : undefined}
        hidden={!props.entry.isCardShrunk}
      >
        <Pressable
          ref={shrunkFaceRef}
          class={faceClassNamesOf(props.entry.model, ['bs-card-shrunk-face'])}
          data-action="board-session-open-card"
          aria-label={shrunkAriaLabelOf(props.entry.model.name)}
          onClick={() => props.actions.toggleOpened(props.entry.sessionId)}
        />
      </div>
    </>
  );
}
