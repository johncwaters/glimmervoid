import { isStreamerMode, onStreamerModeChanged } from './streamer-mode.ts';
import { maskStreamerText } from './streamer-text-core.ts';

type MaskedValue = { original: string; masked: string };

const UNMASKED_SUBTREE_SELECTOR = '.xterm, input, textarea, script, style, [contenteditable]:not([contenteditable="false"])';
const MASKED_ATTRIBUTES = ['title', 'label'];

let maskedTextByNode = new WeakMap<Text, MaskedValue>();
let maskedAttributesByElement = new WeakMap<Element, Map<string, MaskedValue>>();
let textMaskObserver: MutationObserver | null = null;

function isInsideUnmaskedSubtree(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return !element || element.closest(UNMASKED_SUBTREE_SELECTOR) !== null;
}

function isOptionValueDerivedFromText(textNode: Text) {
  const option = textNode.parentElement?.closest('option');
  return option != null && !option.hasAttribute('value');
}

function maskValue(currentValue: string, previous: MaskedValue | undefined): MaskedValue | null {
  if (previous && currentValue === previous.masked) return previous;
  const masked = maskStreamerText(currentValue);
  if (masked === currentValue) return null;
  return { original: currentValue, masked };
}

function maskTextNode(textNode: Text) {
  const maskedValue = isOptionValueDerivedFromText(textNode) ? null : maskValue(textNode.data, maskedTextByNode.get(textNode));
  if (!maskedValue) {
    maskedTextByNode.delete(textNode);
    return;
  }
  maskedTextByNode.set(textNode, maskedValue);
  if (textNode.data !== maskedValue.masked) textNode.data = maskedValue.masked;
}

function maskAttribute(element: Element, attributeName: string) {
  const attributeValue = element.getAttribute(attributeName);
  const maskedAttributes = maskedAttributesByElement.get(element);
  const maskedValue = attributeValue === null ? null : maskValue(attributeValue, maskedAttributes?.get(attributeName));
  if (!maskedValue) {
    maskedAttributes?.delete(attributeName);
    return;
  }
  const attributesToRestore = maskedAttributes ?? new Map<string, MaskedValue>();
  attributesToRestore.set(attributeName, maskedValue);
  maskedAttributesByElement.set(element, attributesToRestore);
  if (attributeValue !== maskedValue.masked) element.setAttribute(attributeName, maskedValue.masked);
}

function maskAttributes(element: Element) {
  for (const attributeName of MASKED_ATTRIBUTES) maskAttribute(element, attributeName);
}

function rejectUnmaskedSubtrees(node: Node) {
  if (node instanceof Element && node.matches(UNMASKED_SUBTREE_SELECTOR)) return NodeFilter.FILTER_REJECT;
  return NodeFilter.FILTER_ACCEPT;
}

function maskSubtree(root: Element) {
  maskAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, rejectUnmaskedSubtrees);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) maskTextNode(node);
    if (node instanceof Element) maskAttributes(node);
  }
}

function maskAddedNode(node: Node) {
  if (isInsideUnmaskedSubtree(node)) return;
  if (node instanceof Text) maskTextNode(node);
  if (node instanceof Element) maskSubtree(node);
}

function maskReattributedElement(node: Node) {
  if (!(node instanceof Element) || isInsideUnmaskedSubtree(node)) return;
  maskAttributes(node);
}

function maskMutations(mutations: MutationRecord[]) {
  const addedOrEditedNodes = new Set<Node>();
  const reattributedElements = new Set<Node>();
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) addedOrEditedNodes.add(node);
    }
    if (mutation.type === 'characterData') addedOrEditedNodes.add(mutation.target);
    if (mutation.type === 'attributes') reattributedElements.add(mutation.target);
  }
  for (const node of addedOrEditedNodes) {
    if (node.isConnected) maskAddedNode(node);
  }
  for (const element of reattributedElements) {
    if (element.isConnected) maskReattributedElement(element);
  }
}

function restoreSubtree(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  restoreNode(root);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) restoreNode(node);
}

function restoreNode(node: Node) {
  if (node instanceof Text) {
    const maskedValue = maskedTextByNode.get(node);
    if (maskedValue && node.data === maskedValue.masked) node.data = maskedValue.original;
    return;
  }
  if (!(node instanceof Element)) return;
  const maskedAttributes = maskedAttributesByElement.get(node);
  if (!maskedAttributes) return;
  for (const [attributeName, maskedValue] of maskedAttributes) {
    if (node.getAttribute(attributeName) === maskedValue.masked) node.setAttribute(attributeName, maskedValue.original);
  }
}

function startMasking() {
  if (textMaskObserver) return;
  const observer = new MutationObserver((mutations) => {
    maskMutations(mutations);
    observer.takeRecords();
  });
  maskSubtree(document.body);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: MASKED_ATTRIBUTES });
  textMaskObserver = observer;
}

function stopMasking() {
  if (!textMaskObserver) return;
  textMaskObserver.disconnect();
  textMaskObserver = null;
  restoreSubtree(document.body);
  maskedTextByNode = new WeakMap();
  maskedAttributesByElement = new WeakMap();
}

function applyStreamerTextMask(isEnabled: boolean) {
  if (isEnabled) {
    startMasking();
    return;
  }
  stopMasking();
}

export function mountStreamerTextMask() {
  applyStreamerTextMask(isStreamerMode());
  onStreamerModeChanged(applyStreamerTextMask);
}
