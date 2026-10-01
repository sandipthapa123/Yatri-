import { ApiError, PhoneNumberInput, toE164 } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import {
  ORG_ROLE_HELP,
  ORG_ROLE_LABELS,
  assignableOrgRoles,
  type OrgMemberInfo,
  type OrgRole,
  type OrganizationInfo,
} from '@yatri/types';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { memberLine } from '../businessText';
import { Problem } from './Field';

/**
 * People in the organization. Who may change whom, and to what, is decided by the server (`canChange` on
 * each row, and the roles the person's own role may give): this lists what it says and sends the choice.
 */
export function MembersSection(
  props: UiProps & {
    org: OrganizationInfo;
    getAccessToken: () => Promise<string>;
    onLeft: () => void;
  },
) {
  const { colors, minTouchTarget, org } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const list = usePolled<OrgMemberInfo[]>(
    async () => businessApi.members(await props.getAccessToken(), org.id),
    60_000,
  );
  const canManage = org.myPermissions.includes('MEMBERS_MANAGE');
  const roles = assignableOrgRoles(org.myRole);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<OrgRole>('MEMBER');

  /** `done` is what to say afterwards; null means say what the work returned. */
  const act = async (work: (t: string) => Promise<unknown>, done: string | null) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await work(await props.getAccessToken());
      say(done ?? String(result));
      await list.reload();
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'That did not work. Please try again.';
      setProblem(text);
      say(text);
    } finally {
      setBusy(false);
    }
  };

  const remove = (m: OrgMemberInfo) =>
    Alert.alert(
      `Remove ${m.name ?? 'this person'}?`,
      'They lose access to the organization. Their past rides stay in the records.',
      [
        { text: 'Go back', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            void act(
              (t) => businessApi.removeMember(t, org.id, m.id),
              `${m.name ?? 'The person'} was removed.`,
            ),
        },
      ],
    );

  const invite = () => {
    const e164 = toE164(phone);
    if (!e164) {
      const text = 'Enter the rider’s full phone number.';
      setProblem(text);
      say(text);
      return;
    }
    void act(async (t) => {
      const r = await businessApi.invite(t, org.id, { phoneNumber: e164, role });
      setPhone('');
      return r.message;
    }, null);
  };

  const leave = () =>
    Alert.alert(
      'Leave this organization?',
      'You will no longer be able to book business rides for it.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              try {
                await businessApi.leave(await props.getAccessToken(), org.id);
                props.onLeft();
              } catch (e) {
                setProblem(
                  e instanceof ApiError ? e.message : 'That did not work. Please try again.',
                );
              }
            })(),
        },
      ],
    );

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      <Card {...ui} title="Members">
        {list.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
        {list.error ? <Problem text={list.error} color={colors.error} /> : null}
        {problem ? <Problem text={problem} color={colors.error} /> : null}
        {list.data?.map((m) => (
          <View key={m.id} style={[styles.row, { borderColor: colors.border }]}>
            <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
              {memberLine(m)}
            </Text>
            {canManage && m.canChange
              ? roles
                  .filter((r) => r !== m.role)
                  .map((r) => (
                    <ActionButton
                      key={r}
                      {...ui}
                      label={`Make ${m.name ?? 'them'} ${ORG_ROLE_LABELS[r].toLowerCase()}`}
                      disabled={busy}
                      onPress={() =>
                        void act(
                          (t) => businessApi.changeMember(t, org.id, m.id, { role: r }),
                          `${m.name ?? 'The person'} is now ${ORG_ROLE_LABELS[r].toLowerCase()}.`,
                        )
                      }
                    />
                  ))
              : null}
            {canManage && m.canChange ? (
              <ActionButton
                {...ui}
                label={`Remove ${m.name ?? 'this person'}`}
                tone="danger"
                disabled={busy}
                onPress={() => remove(m)}
              />
            ) : null}
          </View>
        ))}
      </Card>

      {canManage && roles.length > 0 ? (
        <Card {...ui} title="Invite someone">
          <Text style={{ color: colors.textSecondary }}>
            They need a Yatri rider account. They join when they accept the invitation.
          </Text>
          <PhoneNumberInput value={phone} onChangeValue={setPhone} colors={colors} />
          <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '600' }}>
            Role
          </Text>
          <View accessibilityRole="radiogroup" style={styles.group}>
            {roles.map((r) => (
              <ActionButton
                key={r}
                {...ui}
                role="radio"
                selected={role === r}
                label={ORG_ROLE_LABELS[r]}
                hint={ORG_ROLE_HELP[r]}
                onPress={() => setRole(r)}
              />
            ))}
          </View>
          <Text style={{ color: colors.textSecondary }}>{ORG_ROLE_HELP[role]}</Text>
          <ActionButton
            {...ui}
            label="Send invitation"
            tone="primary"
            busy={busy}
            onPress={invite}
          />
        </Card>
      ) : null}

      <ActionButton {...ui} label="Leave this organization" tone="danger" onPress={leave} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  row: { borderTopWidth: 1, paddingTop: 8, gap: 6 },
  group: { gap: 8 },
});
