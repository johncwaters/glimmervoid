import type { FileContents, FileDiffLoadedFiles, FileDiffMetadata } from '@pierre/diffs';
import type { DiffLayout } from './review-reader-core.ts';

type DiffsModule = typeof import('@pierre/diffs');

const DIFF_THEME_NAME = 'glimmervoid';

export interface DiffFileContents {
  oldContents: string | null;
  newContents: string | null;
}

export interface MountFileDiffOptions {
  patch: string;
  layout: DiffLayout;
  loadContents(): Promise<DiffFileContents>;
  onLoadError(message: string): void;
}

export interface MountedFileDiff {
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

async function loadBothSides(fileDiff: FileDiffMetadata, loadContents: MountFileDiffOptions['loadContents']): Promise<FileDiffLoadedFiles> {
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
  const renderer = new diffs.FileDiff({
    theme: DIFF_THEME_NAME,
    diffStyle: options.layout,
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    disableFileHeader: true,
    overflow: 'scroll',
    loadDiffFiles: (partialDiff) => loadBothSidesOrReport(partialDiff, options),
  });
  renderer.render({ fileDiff, containerWrapper: host });
  return { destroy: () => renderer.cleanUp() };
}
