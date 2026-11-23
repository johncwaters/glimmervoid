import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import type { PlanBlock, PlanInline, PlanListItem } from './plan-markdown-core.ts';

export interface PlanFileRefs {
  canOpen: (path: string) => boolean;
  open: (path: string) => void;
}

interface PlanRenderOptions {
  fileRefs?: PlanFileRefs;
}

function fileRefElement(node: Extract<PlanInline, { type: 'fileRef' }>, options: PlanRenderOptions): HTMLElement {
  const { fileRefs } = options;
  if (!fileRefs) return el('span', 'plan-file-ref', node.text);
  const fileRef = createPressable('plan-file-ref', node.text);
  fileRef.dataset.path = node.path;
  fileRef.disabled = !fileRefs.canOpen(node.path);
  fileRef.addEventListener('click', () => fileRefs.open(node.path));
  return fileRef;
}

function appendInline(parent: HTMLElement, nodes: readonly PlanInline[], options: PlanRenderOptions) {
  for (const node of nodes) {
    if (node.type === 'text') {
      parent.append(document.createTextNode(node.text));
      continue;
    }
    if (node.type === 'code') {
      parent.append(el('code', 'plan-inline-code', node.text));
      continue;
    }
    if (node.type === 'fileRef') {
      parent.append(fileRefElement(node, options));
      continue;
    }
    if (node.type === 'emphasis') {
      const emphasis = el('em');
      appendInline(emphasis, node.children, options);
      parent.append(emphasis);
      continue;
    }
    if (node.type === 'strong') {
      const strong = el('strong');
      appendInline(strong, node.children, options);
      parent.append(strong);
      continue;
    }
    const link = el('a', 'plan-link');
    link.href = node.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    appendInline(link, node.children, options);
    parent.append(link);
  }
}

function renderListItem(item: PlanListItem, options: PlanRenderOptions) {
  const row = el('li');
  appendBlocks(row, item.children, options);
  return row;
}

function appendBlocks(parent: HTMLElement, blocks: readonly PlanBlock[], options: PlanRenderOptions) {
  for (const block of blocks) {
    if (block.type === 'heading') {
      const heading = el(`h${block.level}` as keyof HTMLElementTagNameMap, 'plan-heading');
      heading.id = block.id;
      appendInline(heading, block.children, options);
      parent.append(heading);
      continue;
    }
    if (block.type === 'paragraph') {
      const paragraph = el('p', 'plan-paragraph');
      appendInline(paragraph, block.children, options);
      parent.append(paragraph);
      continue;
    }
    if (block.type === 'list') {
      const list = block.ordered ? el('ol', 'plan-list') : el('ul', 'plan-list');
      if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
      list.append(...block.items.map((item) => renderListItem(item, options)));
      parent.append(list);
      continue;
    }
    if (block.type === 'code') {
      const pre = el('pre', 'plan-code');
      const code = el('code', block.language ? `language-${block.language}` : null, block.text);
      pre.append(code);
      parent.append(pre);
      continue;
    }
    if (block.type === 'table') {
      const tableWrap = el('div', 'plan-table-wrap');
      const table = el('table', 'plan-table');
      const head = el('thead');
      const headRow = el('tr');
      for (const cell of block.header) {
        const headingCell = el('th');
        appendInline(headingCell, cell, options);
        headRow.append(headingCell);
      }
      head.append(headRow);
      const body = el('tbody');
      for (const row of block.rows) {
        const bodyRow = el('tr');
        for (const cell of row) {
          const bodyCell = el('td');
          appendInline(bodyCell, cell, options);
          bodyRow.append(bodyCell);
        }
        body.append(bodyRow);
      }
      table.append(head, body);
      tableWrap.append(table);
      parent.append(tableWrap);
      continue;
    }
    if (block.type === 'blockquote') {
      const quote = el('blockquote', 'plan-blockquote');
      appendBlocks(quote, block.blocks, options);
      parent.append(quote);
      continue;
    }
    parent.append(el('hr', 'plan-rule'));
  }
}

export function renderPlanBlocks(blocks: readonly PlanBlock[], options: PlanRenderOptions = {}): HTMLElement {
  const root = el('div', 'plan-document');
  appendBlocks(root, blocks, options);
  return root;
}
