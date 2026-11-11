import type { DiffLineAnnotation, FileContents, FileDiffLoadedFiles, FileDiffMetadata } from '@pierre/diffs';
import type { DiffLayout } from './review-reader-core.ts';

type DiffsModule = typeof import('@pierre/diffs');

const DIFF_THEME_NAME = 'glimmervoid';

export interface DiffFileContents {
  oldContents: string | null;
  newContents: string | null;
}

export type DiffSide = 'old' | 'new';

export interface DiffAnnotation {
  side: DiffSide;
  line: number;
  key: string;
}

export interface DiffLineClick {
  side: DiffSide;
  line: number;
  renderedText: string;
}

interface MountFileDiffOptions {
  patch: string;
  layout: DiffLayout;
  annotations: readonly DiffAnnotation[];
  loadContents(): Promise<DiffFileContents>;
  onLoadError(message: string): void;
  renderAnnotation(key: string): HTMLElement;
  onLineClick(click: DiffLineClick): void;
}

export interface MountedFileDiff {
  setAnnotations(annotations: readonly DiffAnnotation[]): void;
  destroy(): void;
}

let diffsModulePromise: Promise<DiffsModule> | null = null;

export function preloadDiffRenderer(): Promise<DiffsModule> {
  diffsModulePromise ??= import('@pierre/diffs').then(
    (diffs) => {
      diffs.registerCustomCSSVariableTheme(DIFF_THEME_NAME, {});
      return diffs;
    },
    (error: unknown) => {
      diffsModulePromise = null;
      throw error;
    },
  );
  return diffsModulePromise;
}

function fileContentsOf(name: string, contents: string | null): FileContents {
  if (contents === null) throw new Error(`${name} is too large or not text`);
  return { name, contents };
}

function pierreAnnotationsOf(annotations: readonly DiffAnnotation[]): DiffLineAnnotation<string>[] {
  return annotations.map((annotation) => ({ side: annotation.side === 'old' ? 'deletions' : 'additions', lineNumber: annotation.line, metadata: annotation.key }));
}

async function loadBothSides(fileDiff: FileDiffMetadata, loadContents: () => Promise<DiffFileContents>): Promise<FileDiffLoadedFiles> {
  const oldName = fileDiff.prevName ?? fileDiff.name;
  const { oldContents, newContents } = await loadContents();
  const newFile = fileContentsOf(fileDiff.name, newContents);
  if (fileDiff.type === 'rename-pure') return { oldFile: null, newFile };
  return { oldFile: fileContentsOf(oldName, oldContents), newFile };
}

async function loadBothSidesOrReport(fileDiff: FileDiffMetadata, options: MountFileDiffOptions): Promise<FileDiffLoadedFiles> {
  try {
    return await loadBothSides(fileDiff, options.loadContents);
  } catch (error) {
    options.onLoadError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function mountFileDiff(host: HTMLElement, options: MountFileDiffOptions): Promise<MountedFileDiff> {
  const diffs = await preloadDiffRenderer();
  const fileDiff = diffs.processFile(options.patch, { isGitDiff: true });
  if (!fileDiff) throw new Error('This file diff could not be read');
  const renderer = new diffs.FileDiff<string>({
    theme: DIFF_THEME_NAME,
    diffStyle: options.layout,
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    disableFileHeader: true,
    overflow: 'scroll',
    lineHoverHighlight: 'line',
    loadDiffFiles: (partialDiff) => loadBothSidesOrReport(partialDiff, options),
    renderAnnotation: (annotation) => options.renderAnnotation(annotation.metadata),
    onLineClick: (click) => options.onLineClick({
      side: click.annotationSide === 'deletions' ? 'old' : 'new',
      line: click.lineNumber,
      renderedText: (click.lineElement.textContent ?? '').replace(/\n$/, ''),
    }),
  });
  renderer.render({ fileDiff, containerWrapper: host, lineAnnotations: pierreAnnotationsOf(options.annotations) });
  return {
    setAnnotations: (annotations) => {
      renderer.setLineAnnotations(pierreAnnotationsOf(annotations));
      renderer.rerender();
    },
    destroy: () => renderer.cleanUp(),
  };
}
