import {
  DATA_REQUEST_KIND_LABELS,
  DATA_REQUEST_STATUS_LABELS,
  type DataRequestInfo,
  type DataRequestKind,
  type MyPolicyStatus,
} from '@yatri/types';
import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, Fact, type UiProps } from '@yatri/mobile-ride';
import { useState } from 'react';
import { Linking, Share, StyleSheet, Text, View } from 'react-native';

import { useNews, usePolled } from '../hooks';
import { supportApi } from '../supportApi';
import { whenText } from '../supportText';

/**
 * Privacy and my data: which policies the person has accepted (and which are waiting), a copy of their
 * data, and deleting their account. A policy is shown as its title, version and where to read it: the
 * words are never kept in the app. Deleting an account asks twice, in the page, and says plainly what is
 * removed and what must be kept. (Pausing an account is Deactivate, on the profile screen.)
 */
export function PrivacyPanel(
  props: UiProps & { getAccessToken: () => Promise<string>; onBack: () => void },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const policies = usePolled<MyPolicyStatus[]>(
    async () => supportApi.policies(await props.getAccessToken()),
    null,
  );
  const requests = usePolled<DataRequestInfo[]>(
    async () => supportApi.dataRequests(await props.getAccessToken()),
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const act = async (id: string, work: (token: string) => Promise<void>, done: string) => {
    setBusy(id);
    setFailure(null);
    try {
      await work(await props.getAccessToken());
      say(done);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'That did not work. Please try again.';
      setFailure(message);
      say(message);
    } finally {
      setBusy(null);
    }
  };

  const open = (kind: DataRequestKind) =>
    requests.data?.some(
      (r) => r.kind === kind && (r.status === 'REQUESTED' || r.status === 'REVIEWING'),
    );
  const pending = policies.data?.filter((p) => p.required && !p.accepted).length ?? 0;

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      {failure ? (
        <Text accessibilityRole="alert" style={{ color: colors.error, fontWeight: '600' }}>
          {`Problem: ${failure}`}
        </Text>
      ) : null}

      <Card {...ui} title="Policies and consent">
        {pending > 0 ? (
          <Text accessibilityRole="alert" style={{ color: colors.textPrimary, fontWeight: '700' }}>
            {`${pending} ${pending === 1 ? 'policy is' : 'policies are'} waiting for you to read and accept.`}
          </Text>
        ) : null}
        {policies.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
        {policies.error ? (
          <Text accessibilityRole="alert" style={{ color: colors.error }}>
            {policies.error}
          </Text>
        ) : null}
        {policies.data?.map((p) => (
          <View key={p.key} style={[styles.policy, { borderColor: colors.border }]}>
            <Fact
              {...ui}
              label={`${p.title} (version ${p.version})`}
              value={
                p.accepted
                  ? `Accepted on ${whenText(p.acceptedAt as string)}`
                  : p.acceptedVersion
                    ? `A newer version needs your answer (you accepted version ${p.acceptedVersion})`
                    : p.required
                      ? 'Not accepted yet'
                      : 'Not accepted'
              }
            />
            {p.contentUrl ? (
              <ActionButton
                {...ui}
                label={`Read ${p.title}`}
                onPress={() => void Linking.openURL(p.contentUrl as string)}
              />
            ) : (
              <Text style={{ color: colors.textSecondary }}>
                The full text has not been published yet.
              </Text>
            )}
            {!p.accepted ? (
              <ActionButton
                {...ui}
                label={`Accept ${p.title}`}
                tone="primary"
                busy={busy === p.key}
                onPress={() =>
                  void act(
                    p.key,
                    async (t) => {
                      await supportApi.accept(t, { key: p.key, version: p.version });
                      await policies.reload();
                    },
                    `${p.title} accepted.`,
                  )
                }
              />
            ) : null}
          </View>
        ))}
      </Card>

      <Card {...ui} title="Your data">
        <Text style={{ color: colors.textSecondary }}>
          You can ask for a copy of the personal data we hold about you. We answer within the time
          shown on the request.
        </Text>
        {requests.data?.map((r) => (
          <View key={r.id} style={[styles.policy, { borderColor: colors.border }]}>
            <Fact
              {...ui}
              label={DATA_REQUEST_KIND_LABELS[r.kind]}
              value={`${DATA_REQUEST_STATUS_LABELS[r.status]}. ${r.statusText}`}
            />
            <Text
              style={{ color: colors.textSecondary }}
            >{`Asked on ${whenText(r.createdAt)}. Answer due by ${whenText(r.dueAt)}.`}</Text>
            {r.decisionNote ? (
              <Text style={{ color: colors.textPrimary }}>{`Note from us: ${r.decisionNote}`}</Text>
            ) : null}
            {r.canDownload ? (
              <ActionButton
                {...ui}
                label="Get my data copy"
                busy={busy === r.id}
                onPress={() =>
                  void act(
                    r.id,
                    async (t) => {
                      const copy = await supportApi.dataCopy(t, r.id);
                      await Share.share({
                        title: 'My Yatri data',
                        message: JSON.stringify(copy, null, 2),
                      });
                    },
                    'Your data copy is ready to share.',
                  )
                }
              />
            ) : null}
            {r.canCancel ? (
              <ActionButton
                {...ui}
                label="Withdraw this request"
                busy={busy === r.id}
                onPress={() =>
                  void act(
                    r.id,
                    async (t) => {
                      await supportApi.cancelDataRequest(t, r.id);
                      await requests.reload();
                    },
                    'Your request was withdrawn.',
                  )
                }
              />
            ) : null}
          </View>
        ))}
        <ActionButton
          {...ui}
          label="Ask for a copy of my data"
          busy={busy === 'copy'}
          disabled={!!open('DATA_ACCESS')}
          hint={open('DATA_ACCESS') ? 'You already have a request being handled' : undefined}
          onPress={() =>
            void act(
              'copy',
              async (t) => {
                await supportApi.requestData(t, { kind: 'DATA_ACCESS' });
                await requests.reload();
              },
              'Your request for a copy of your data was received.',
            )
          }
        />
      </Card>

      {confirmDelete ? (
        <Card {...ui} title="Delete your account?" focusOnMount>
          <Text style={{ color: colors.textPrimary }}>
            We will remove your name, phone number, saved places, emergency contacts and, for
            drivers, your identity documents, and you will be signed out for good. We must keep the
            record of rides, payments, refunds and support requests, without your name on them. This
            cannot be undone.
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            We cannot delete an account while a ride is under way or a payment is unsettled; we will
            tell you if that is the case.
          </Text>
          <ActionButton
            {...ui}
            label="Yes, ask to delete my account"
            tone="danger"
            busy={busy === 'delete'}
            onPress={() =>
              void act(
                'delete',
                async (t) => {
                  await supportApi.requestData(t, { kind: 'ACCOUNT_DELETION' });
                  setConfirmDelete(false);
                  await requests.reload();
                },
                'Your request to delete your account was received.',
              )
            }
          />
          <ActionButton
            {...ui}
            label="No, keep my account"
            onPress={() => setConfirmDelete(false)}
          />
        </Card>
      ) : (
        <Card {...ui} title="Delete my account">
          <Text style={{ color: colors.textSecondary }}>
            Ask us to delete your account and personal details. Some records must be kept by law or
            for accounting.
          </Text>
          <ActionButton
            {...ui}
            label="Delete my account"
            tone="danger"
            disabled={!!open('ACCOUNT_DELETION')}
            hint={open('ACCOUNT_DELETION') ? 'You already asked; it is being handled' : undefined}
            onPress={() => setConfirmDelete(true)}
          />
        </Card>
      )}

      <ActionButton {...ui} label="Back" onPress={props.onBack} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  policy: { borderTopWidth: 1, paddingTop: 8, gap: 6 },
});
