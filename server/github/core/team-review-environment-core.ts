import { EFFORT_OPTION_ID } from '../../../shared/contracts/agent-models.ts';
import type { CatalogModel } from '../../../shared/contracts/agent-models.ts';
import type { ReviewModelOffer } from '../../../shared/contracts/team-review-environment.ts';

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function enabledClaudePluginInstalls(installedPlugins: unknown, settings: unknown): { pluginName: string; installPath: string }[] {
  const pluginsByKey = installedPlugins && typeof installedPlugins === 'object' ? (installedPlugins as Record<string, unknown>).plugins : null;
  const enabledByKey = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).enabledPlugins : null;
  if (!pluginsByKey || typeof pluginsByKey !== 'object' || !enabledByKey || typeof enabledByKey !== 'object') return [];
  return Object.entries(pluginsByKey as Record<string, unknown>).flatMap(([pluginKey, installs]) => {
    if ((enabledByKey as Record<string, unknown>)[pluginKey] !== true || !Array.isArray(installs)) return [];
    const installPath = installs.map((install) => (install && typeof install === 'object' ? textField(install as Record<string, unknown>, 'installPath') : null)).find((candidate) => candidate !== null);
    if (!installPath) return [];
    return [{ pluginName: pluginKey.split('@')[0], installPath }];
  });
}

function reviewModelOffer(model: CatalogModel): ReviewModelOffer {
  const effort = model.options.find((option) => option.id === EFFORT_OPTION_ID) ?? null;
  return { id: model.aliases[0] ?? model.id, label: model.label, efforts: effort ? [...effort.choices] : null, defaultEffort: effort?.defaultChoice ?? null };
}

function reviewModelOffers(models: readonly CatalogModel[]): { models: ReviewModelOffer[]; efforts: string[] } {
  const offers = models.map(reviewModelOffer);
  return { models: offers, efforts: [...new Set(offers.flatMap((offer) => offer.efforts ?? []))] };
}

export {
  reviewModelOffers,
  enabledClaudePluginInstalls,
};
