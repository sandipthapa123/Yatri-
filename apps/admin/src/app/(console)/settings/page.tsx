import { SETTING_GROUPS, SETTING_GROUP_LABELS } from '@yatri/types';

import { getPlatformSettings, listVehicleCategories } from '../../../lib/apiClient';
import { loadOrDenied } from '../../../lib/access';
import { requireAdminAccessToken } from '../../../lib/session';
import { styles } from '../drivers/styles';
import { NoAccess } from '../ui/NoAccess';
import { CategoryEditor, SettingEditor } from './Editors';

/**
 * Platform settings: the one place fares, cancellation, waiting, availability and notification
 * thresholds are changed. What is saved here is what the API applies to the next ride; the apps
 * receive it from the API and keep no copy. Every change is confirmed, needs a reason, and is
 * written to the audit log.
 */
export default async function SettingsPage() {
  const token = await requireAdminAccessToken();
  const { data, denied } = await loadOrDenied(async () => {
    const [settings, categories] = await Promise.all([
      getPlatformSettings(token),
      listVehicleCategories(token),
    ]);
    return { settings, categories };
  });
  if (denied || !data) return <NoAccess what="platform settings" />;
  const { settings, categories } = data;

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Settings</h1>
      {!settings.canManage ? (
        <p style={{ margin: 0 }}>You can read these settings but not change them.</p>
      ) : null}

      {SETTING_GROUPS.map((g) => {
        const inGroup = settings.settings.filter((s) => s.group === g);
        if (inGroup.length === 0) return null;
        return (
          <section key={g} aria-labelledby={`g-${g}`} style={styles.section}>
            <h2 id={`g-${g}`} style={styles.sectionTitle}>
              {SETTING_GROUP_LABELS[g]}
            </h2>
            {inGroup.map((s) => (
              <div key={s.key} style={{ display: 'grid', gap: 4, paddingBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>{s.label}</h3>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary)' }}>
                  {s.help}
                </p>
                <SettingEditor setting={s} canManage={settings.canManage} />
              </div>
            ))}
          </section>
        );
      })}

      <section aria-labelledby="cat-h" style={styles.section}>
        <h2 id="cat-h" style={styles.sectionTitle}>
          Vehicle categories
        </h2>
        {categories.map((c) => (
          <div key={c.id} style={{ paddingBottom: 12 }}>
            <CategoryEditor category={c} canManage={settings.canManage} />
          </div>
        ))}
      </section>
    </div>
  );
}
