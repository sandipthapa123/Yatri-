import { ActionButton, Card, type UiProps } from '@yatri/mobile-ride';
import { usePolled } from '@yatri/mobile-support';
import { ORG_ROLE_HELP, ORG_ROLE_LABELS, type OrganizationInfo } from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { sectionsFor, type SectionId } from '../businessText';
import { Problem } from './Field';
import { MembersSection } from './Members';
import { OrganizationList } from './OrganizationList';
import { PolicySection } from './Policy';
import { ApprovalsSection, RidesSection } from './RidesAndApprovals';
import { StatementsSection, UsageSection } from './StatementsAndUsage';

/**
 * The business area of the app: your organizations, and for each one the sections your role allows. The list of
 * sections is built from the permissions the server returned for your role, so a role never sees a door that is
 * locked, and what the server refuses it still refuses.
 */
export function BusinessCenter(
  props: UiProps & { getAccessToken: () => Promise<string>; onExit: () => void },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [orgId, setOrgId] = useState<string | null>(null);
  return (
    <View style={styles.container}>
      {orgId ? (
        <OrganizationHome
          {...ui}
          orgId={orgId}
          getAccessToken={props.getAccessToken}
          onBack={() => setOrgId(null)}
        />
      ) : (
        <>
          <OrganizationList {...ui} getAccessToken={props.getAccessToken} onOpen={setOrgId} />
          <ActionButton {...ui} label="Back" onPress={props.onExit} />
        </>
      )}
    </View>
  );
}

function OrganizationHome(
  props: UiProps & { orgId: string; getAccessToken: () => Promise<string>; onBack: () => void },
) {
  const { colors, minTouchTarget, orgId } = props;
  const ui = { colors, minTouchTarget };
  const info = usePolled<OrganizationInfo>(
    async () => businessApi.get(await props.getAccessToken(), orgId),
    120_000,
  );
  const [section, setSection] = useState<SectionId>('rides');
  const org = info.data;
  const sections = org ? sectionsFor(org.myPermissions) : [];
  const current = sections.find((s) => s.id === section)?.id ?? 'rides';
  const section$ = { ...ui, orgId, getAccessToken: props.getAccessToken };

  return (
    <View style={styles.container}>
      <ActionButton {...ui} label="All organizations" onPress={props.onBack} />
      {info.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
      {info.error ? <Problem text={info.error} color={colors.error} /> : null}
      {org ? (
        <>
          <Card {...ui} title={org.name}>
            <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
              {`You are ${ORG_ROLE_LABELS[org.myRole].toLowerCase()}. ${ORG_ROLE_HELP[org.myRole]}`}
            </Text>
            {org.status === 'SUSPENDED' ? (
              <Text
                accessibilityRole="alert"
                style={{ color: colors.textPrimary, fontWeight: '700' }}
              >
                This organization is suspended: new business rides cannot be booked. Please contact
                Yatri support.
              </Text>
            ) : null}
          </Card>
          <View accessibilityRole="tablist" style={styles.tabs}>
            {sections.map((s) => (
              <ActionButton
                key={s.id}
                {...ui}
                role="tab"
                selected={current === s.id}
                label={s.label}
                onPress={() => setSection(s.id)}
              />
            ))}
          </View>
          {current === 'rides' ? <RidesSection {...section$} /> : null}
          {current === 'approvals' ? <ApprovalsSection {...section$} /> : null}
          {current === 'members' ? (
            <MembersSection
              {...ui}
              org={org}
              getAccessToken={props.getAccessToken}
              onLeft={props.onBack}
            />
          ) : null}
          {current === 'policy' ? (
            <PolicySection {...ui} org={org} getAccessToken={props.getAccessToken} />
          ) : null}
          {current === 'statements' ? <StatementsSection {...section$} /> : null}
          {current === 'usage' ? <UsageSection {...section$} /> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  tabs: { gap: 8 },
});
