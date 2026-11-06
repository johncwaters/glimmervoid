import { el } from '../dom-helpers.ts';
import { writeDataIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { hostStatuses, hostStatusText } from './host-status.ts';

interface HostHeader {
  header: HTMLDivElement;
  label: HTMLSpanElement;
  stateText: HTMLSpanElement;
}

const THIS_MACHINE_LABEL = 'This machine';

let thisMachineHeader: HostHeader | null = null;
const remoteHeaderById = new Map<string, HostHeader>();

function buildHostHeader(): HostHeader {
  const header = el('div', 'rail-host-header');
  const label = el('span', 'rail-host-label');
  const stateText = el('span', 'rail-host-state');
  header.append(label, stateText);
  return { header, label, stateText };
}

function paintHostHeader(refs: HostHeader, name: string, state: string, text: string) {
  writeTextIfChanged(refs.label, name);
  writeDataIfChanged(refs.header, 'state', state);
  writeTextIfChanged(refs.stateText, text);
  writeHiddenIfChanged(refs.stateText, text === '');
}

function placeBefore(rail: HTMLElement, node: HTMLElement, anchor: Element | null) {
  const isInPlace = node.parentElement === rail && (anchor ? node.nextElementSibling === anchor : rail.lastElementChild === node);
  if (!isInPlace) rail.insertBefore(node, anchor);
}

function removeHeadersOfGoneHosts(presentIds: ReadonlySet<string>) {
  for (const [id, refs] of [...remoteHeaderById]) {
    if (presentIds.has(id)) continue;
    refs.header.remove();
    remoteHeaderById.delete(id);
  }
}

export function placeHostHeaders(rail: HTMLElement, { firstGroupHeaderOf, trailingNode }: {
  firstGroupHeaderOf: (hostId: string | null) => Element | null;
  trailingNode: Element | null;
}) {
  const statuses = hostStatuses();
  removeHeadersOfGoneHosts(new Set(statuses.map((status) => status.id)));
  if (statuses.length === 0) {
    thisMachineHeader?.header.remove();
    return;
  }
  let anchor = trailingNode;
  for (const status of statuses.toReversed()) {
    const refs = remoteHeaderById.get(status.id) ?? buildHostHeader();
    remoteHeaderById.set(status.id, refs);
    paintHostHeader(refs, status.name, status.state, hostStatusText(status));
    placeBefore(rail, refs.header, firstGroupHeaderOf(status.id) ?? anchor);
    anchor = refs.header;
  }
  thisMachineHeader ??= buildHostHeader();
  paintHostHeader(thisMachineHeader, THIS_MACHINE_LABEL, 'local', '');
  placeBefore(rail, thisMachineHeader.header, firstGroupHeaderOf(null) ?? anchor);
}
