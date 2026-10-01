import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import { formatNpr, type OrgApprovalInfo, type OrgRideRow } from '@yatri/types';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { approvalLine } from '../businessText';
import { Problem } from './Field';

type Section = UiProps & { orgId: string; getAccessToken: () => Promise<string> };

const when = (iso: string) => new Date(iso).toLocaleString();

/** The organization's rides, newest first: who booked, who rode, where, what it cost and how it is paid. */
export function RidesSection(props: Section) {
  const { colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<OrgRideRow[]>([]);
  const [total, setTotal] = useState(0);
  const first = usePolled<{ items: OrgRideRow[]; total: number }>(
    async () => businessApi.rides(await props.getAccessToken(), props.orgId, 1),
    null,
    (d) => {
      setRows(d.items);
      setTotal(d.total);
    },
  );
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const loadMore = async () => {
    setBusy(true);
    try {
      const d = await businessApi.rides(await props.getAccessToken(), props.orgId, page + 1);
      setRows((r) => [...r, ...d.items]);
      setPage(page + 1);
    } catch (e) {
      setMore(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card {...ui} title="Rides">
      {first.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
      {first.error ? <Problem text={first.error} color={colors.error} /> : null}
      {!first.loading && rows.length === 0 ? (
        <Text style={{ color: colors.textSecondary }}>No rides yet.</Text>
      ) : null}
      {rows.map((r) => (
        <View
          key={r.tripId}
          accessible
          accessibilityLabel={rideLine(r)}
          style={[styles.row, { borderColor: colors.border }]}
        >
          <Text
            style={{ color: colors.textPrimary, fontWeight: '600' }}
          >{`${when(r.requestedAt)}: ${r.passengerName ?? 'A member'}`}</Text>
          <Text
            style={{ color: colors.textPrimary }}
          >{`${r.pickupAddress} to ${r.destinationAddress}`}</Text>
          <Text style={{ color: colors.textSecondary }}>{rideLine(r)}</Text>
        </View>
      ))}
      {more ? <Problem text={more} color={colors.error} /> : null}
      {rows.length < total ? (
        <ActionButton
          {...ui}
          label={`Show more rides (${rows.length} of ${total})`}
          busy={busy}
          onPress={() => void loadMore()}
        />
      ) : null}
    </Card>
  );
}

function rideLine(r: OrgRideRow): string {
  const bits = [
    r.status.toLowerCase().replaceAll('_', ' '),
    formatNpr(r.costNpr),
    r.paymentStatus,
    r.bookedByName && r.bookedByName !== r.passengerName ? `booked by ${r.bookedByName}` : null,
    r.costCenterCode ? `cost centre ${r.costCenterCode}` : null,
    r.purpose,
    r.statementNumber ? `statement ${r.statementNumber}` : null,
  ];
  return bits.filter(Boolean).join(', ');
}

/** Rides waiting for approval (for those who approve), and the person's own requests. */
export function ApprovalsSection(props: Section) {
  const { colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const [news, say] = useNews();
  const list = usePolled<OrgApprovalInfo[]>(
    async () => businessApi.approvals(await props.getAccessToken(), props.orgId),
    30_000,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const act = async (id: string, work: (t: string) => Promise<unknown>, done: string) => {
    setBusy(id);
    setProblem(null);
    try {
      await work(await props.getAccessToken());
      say(done);
      await list.reload();
    } catch (e) {
      const text = e instanceof ApiError ? e.message : 'That did not work. Please try again.';
      setProblem(text);
      say(text);
      await list.reload();
    } finally {
      setBusy(null);
    }
  };
  const decide = (a: OrgApprovalInfo, decision: 'APPROVE' | 'DECLINE') =>
    Alert.alert(
      decision === 'APPROVE' ? 'Approve this ride?' : 'Decline this ride?',
      decision === 'APPROVE'
        ? 'A driver is sent for the rider straight away, at the fare it is now.'
        : 'No ride is requested and the person who asked is told.',
      [
        { text: 'Go back', style: 'cancel' },
        {
          text: decision === 'APPROVE' ? 'Approve' : 'Decline',
          style: decision === 'DECLINE' ? 'destructive' : 'default',
          onPress: () =>
            void act(
              a.id,
              (t) => businessApi.decide(t, props.orgId, a.id, { decision }),
              decision === 'APPROVE' ? 'Approved. The ride was requested.' : 'Declined.',
            ),
        },
      ],
    );

  return (
    <Card {...ui} title="Approvals and requests">
      <Announcer {...ui} polite={news} />
      {list.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
      {list.error ? <Problem text={list.error} color={colors.error} /> : null}
      {problem ? <Problem text={problem} color={colors.error} /> : null}
      {list.data && list.data.length === 0 ? (
        <Text style={{ color: colors.textSecondary }}>Nothing is waiting.</Text>
      ) : null}
      {list.data?.map((a) => (
        <View key={a.id} style={[styles.row, { borderColor: colors.border }]}>
          <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
            {approvalLine(a)}
          </Text>
          {a.status === 'PENDING' ? (
            <Text
              style={{ color: colors.textSecondary, fontSize: 13 }}
            >{`Expires ${when(a.expiresAt)}.`}</Text>
          ) : null}
          {a.decisionNote ? (
            <Text style={{ color: colors.textSecondary }}>{`Note: ${a.decisionNote}`}</Text>
          ) : null}
          {a.canDecide ? (
            <>
              <ActionButton
                {...ui}
                label="Approve"
                tone="primary"
                busy={busy === a.id}
                onPress={() => decide(a, 'APPROVE')}
              />
              <ActionButton
                {...ui}
                label="Decline"
                tone="danger"
                disabled={busy === a.id}
                onPress={() => decide(a, 'DECLINE')}
              />
            </>
          ) : null}
          {a.canCancel ? (
            <ActionButton
              {...ui}
              label="Withdraw this request"
              disabled={busy === a.id}
              onPress={() =>
                void act(
                  a.id,
                  (t) => businessApi.cancelApproval(t, props.orgId, a.id),
                  'Your request was withdrawn.',
                )
              }
            />
          ) : null}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { borderTopWidth: 1, paddingTop: 8, gap: 4 },
});
