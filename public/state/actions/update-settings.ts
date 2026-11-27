import { defineAction } from '../define-action.ts';
import type { SettingsPayload } from '../../settings/settings-view-core.ts';
import settingsCollection from '../collections/settings.ts';
import { applyOptimisticSettingsPatch } from '../settings-core.ts';

interface UpdateSettingsInput {
  settings: SettingsPayload;
}

const updateSettingsAction = defineAction<UpdateSettingsInput>({
  type: 'update-settings',
  payload: ({ settings }) => ({ settings }),
  optimistic: ({ settings }, apply) => {
    apply(settingsCollection, (draft) => {
      applyOptimisticSettingsPatch(draft, settings);
    });
  },
  noticeSource: 'Settings',
  rollbackNotice: (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not save settings: ${detail}`;
  },
});

export default updateSettingsAction;
