import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import { ORG_ROLE_LABELS, type OrgInvitationInfo, type OrganizationInfo } from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { checkOrganizationName } from '../businessText';
import { Field, Problem } from './Field';

/**
 * Business accounts the person belongs to, invitations waiting for an answer, and starting a new one.
 * Whoever starts one becomes its owner. Nothing here says what a role may do: that comes from the server
 * once an organization is opened.
 */
export function OrganizationList(
  props: UiProps & { getAccessToken: () => Promise<string>; onOpen: (orgId: string) => void },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const mine = usePolled<OrganizationInfo[]>(
    async () => businessApi.mine(await props.getAccessToken()),
    null,
  );
  const invites = usePolled<OrgInvitationInfo[]>(
    async () => businessApi.invitations(await props.getAccessToken()),
    60_000,
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const answer = async (i: OrgInvitationInfo, accept: boolean) => {
    setBusy(true);
    try {
      await businessApi.answerInvitation(await props.getAccessToken(), i.organizationId, accept);
      say(
        accept
          ? `You joined ${i.organizationName}.`
          : `You declined the invitation from ${i.organizationName}.`,
      );
      await Promise.all([mine.reload(), invites.reload()]);
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const found = checkOrganizationName(name, email);
    setProblem(found);
    if (found) {
      say(`Please fix this first: ${found}`);
      return;
    }
    setBusy(true);
    try {
      const o = await businessApi.create(await props.getAccessToken(), {
        name: name.trim(),
        ...(email.trim() ? { billingEmail: email.trim() } : {}),
      });
      say(`${o.name} was created. You are its owner.`);
      setCreating(false);
      setName('');
      setEmail('');
      props.onOpen(o.id);
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'That did not work. Please try again.';
      setProblem(text);
      say(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      {invites.data && invites.data.length > 0 ? (
        <Card {...ui} title="Invitations">
          {invites.data.map((i) => (
            <View key={i.organizationId} style={styles.row}>
              <Text style={{ color: colors.textPrimary }}>
                {`${i.organizationName} invited you as ${ORG_ROLE_LABELS[i.role].toLowerCase()}.`}
              </Text>
              <ActionButton
                {...ui}
                label={`Accept: ${i.organizationName}`}
                tone="primary"
                busy={busy}
                onPress={() => void answer(i, true)}
              />
              <ActionButton
                {...ui}
                label={`Decline: ${i.organizationName}`}
                disabled={busy}
                onPress={() => void answer(i, false)}
              />
            </View>
          ))}
        </Card>
      ) : null}

      <Card {...ui} title="Your organizations">
        {mine.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
        {mine.error ? <Problem text={mine.error} color={colors.error} /> : null}
        {mine.data && mine.data.length === 0 ? (
          <Text style={{ color: colors.textSecondary }}>
            You are not in an organization yet. Accept an invitation, or start one for your
            business.
          </Text>
        ) : null}
        {mine.data?.map((o) => (
          <ActionButton
            key={o.id}
            {...ui}
            label={`${o.name}, ${ORG_ROLE_LABELS[o.myRole].toLowerCase()}${o.status === 'SUSPENDED' ? ', suspended' : ''}`}
            hint="Opens this organization"
            onPress={() => props.onOpen(o.id)}
          />
        ))}
      </Card>

      {creating ? (
        <Card {...ui} title="Start an organization" focusOnMount>
          <Field
            {...ui}
            label="Name of the organization"
            value={name}
            onChangeText={setName}
            maxLength={100}
          />
          <Field
            {...ui}
            label="Billing email (optional)"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            hint="Statements are announced in the app; this is where your accounts team can be reached."
          />
          {problem ? <Problem text={problem} color={colors.error} /> : null}
          <ActionButton
            {...ui}
            label="Create the organization"
            tone="primary"
            busy={busy}
            onPress={() => void create()}
          />
          <ActionButton {...ui} label="Cancel" onPress={() => setCreating(false)} />
        </Card>
      ) : (
        <ActionButton {...ui} label="Start an organization" onPress={() => setCreating(true)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  row: { gap: 8 },
});
