import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Card, type UiProps } from '@yatri/mobile-ride';
import { usePolled } from '@yatri/mobile-support';
import {
  ORG_STATEMENT_STATUS_LABELS,
  formatNpr,
  type OrgStatementDetail,
  type OrgStatementInfo,
  type OrgUsageReport,
} from '@yatri/types';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { statementLine } from '../businessText';
import { Problem } from './Field';

type Section = UiProps & { orgId: string; getAccessToken: () => Promise<string> };

/** Monthly statements, newest first, each opening to the rides on it and the totals by cost centre. */
export function StatementsSection(props: Section) {
  const { colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const list = usePolled<OrgStatementInfo[]>(
    async () => businessApi.statements(await props.getAccessToken(), props.orgId),
    null,
  );
  const [open, setOpen] = useState<OrgStatementDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const show = async (id: string) => {
    setProblem(null);
    try {
      setOpen(await businessApi.statement(await props.getAccessToken(), props.orgId, id));
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    }
  };

  if (open) {
    return (
      <Card {...ui} title={`Statement ${open.number}, ${open.periodKey}`} focusOnMount>
        <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
          {statementLine(open)}
        </Text>
        {open.status === 'PAID' && open.paidReference ? (
          <Text
            style={{ color: colors.textSecondary }}
          >{`Payment reference ${open.paidReference}.`}</Text>
        ) : null}
        <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '600' }}>
          By cost centre
        </Text>
        {open.byCostCenter.map((g) => (
          <Text key={g.code ?? 'none'} style={{ color: colors.textPrimary }}>
            {`${g.code ? `${g.code}, ${g.name ?? ''}` : 'No cost centre'}: ${g.rides} ride${g.rides === 1 ? '' : 's'}, ${formatNpr(g.totalNpr)}`}
          </Text>
        ))}
        <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '600' }}>
          Rides
        </Text>
        {open.lines.map((l) => (
          <Text key={l.tripId} style={{ color: colors.textPrimary }} accessibilityRole="text">
            {`${l.endedAt ? new Date(l.endedAt).toLocaleDateString() : ''} ${l.passengerName ?? 'A member'}${l.bookedByName && l.bookedByName !== l.passengerName ? `, booked by ${l.bookedByName}` : ''}, ${l.pickupAddress} to ${l.destinationAddress}${l.costCenterCode ? `, ${l.costCenterCode}` : ''}${l.purpose ? `, ${l.purpose}` : ''}: ${formatNpr(l.amountNpr)}`}
          </Text>
        ))}
        <ActionButton {...ui} label="Back to statements" onPress={() => setOpen(null)} />
      </Card>
    );
  }
  return (
    <Card {...ui} title="Statements">
      <Text style={{ color: colors.textSecondary }}>
        A statement is issued each month for rides billed to the organization. Yatri records it as
        paid when it receives the payment.
      </Text>
      {list.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
      {list.error ? <Problem text={list.error} color={colors.error} /> : null}
      {problem ? <Problem text={problem} color={colors.error} /> : null}
      {list.data && list.data.length === 0 ? (
        <Text style={{ color: colors.textSecondary }}>No statements yet.</Text>
      ) : null}
      {list.data?.map((s) => (
        <ActionButton
          key={s.id}
          {...ui}
          label={statementLine(s)}
          accessibilityLabel={`${statementLine(s)} ${ORG_STATEMENT_STATUS_LABELS[s.status]}`}
          hint="Opens the statement"
          onPress={() => void show(s.id)}
        />
      ))}
    </Card>
  );
}

/** Usage over the last week, month or quarter, by month, cost centre, rider and vehicle type, all as text. */
export function UsageSection(props: Section) {
  const { colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d');
  const report = usePolled<OrgUsageReport>(
    async () => businessApi.usage(await props.getAccessToken(), props.orgId, range),
    null,
  );
  // Picking another range loads it (the loader above always sees the latest range).
  useEffect(() => {
    void report.reload();
  }, [range]);
  const r = report.data;
  return (
    <View style={styles.container}>
      <Card {...ui} title="Usage">
        <View accessibilityRole="radiogroup" style={styles.group}>
          {(['7d', '30d', '90d'] as const).map((x) => (
            <ActionButton
              key={x}
              {...ui}
              role="radio"
              selected={range === x}
              label={x === '7d' ? 'Last 7 days' : x === '30d' ? 'Last 30 days' : 'Last 90 days'}
              onPress={() => setRange(x)}
            />
          ))}
        </View>
        {report.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
        {report.error ? <Problem text={report.error} color={colors.error} /> : null}
        {r ? (
          <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
            {`${r.range.label}: ${r.rides} rides, ${r.completed} completed, ${r.cancelled} cancelled, ${formatNpr(r.spendNpr)} spent.`}
          </Text>
        ) : null}
      </Card>
      {r ? (
        <>
          <Breakdown
            {...ui}
            title="By cost centre"
            rows={r.byCostCenter.map((c) => [
              c.code ? `${c.code}, ${c.name ?? ''}` : 'No cost centre',
              c.rides,
              c.spendNpr,
            ])}
          />
          <Breakdown
            {...ui}
            title="By rider"
            rows={r.byMember.map((m) => [m.name ?? 'Unnamed', m.rides, m.spendNpr])}
          />
          <Breakdown
            {...ui}
            title="By vehicle type"
            rows={r.byCategory.map((c) => [c.label ?? 'Unknown', c.rides, c.spendNpr])}
          />
          <Breakdown
            {...ui}
            title="By month"
            rows={r.byMonth.map((m) => [m.month, m.rides, m.spendNpr])}
          />
        </>
      ) : null}
    </View>
  );
}

function Breakdown(props: UiProps & { title: string; rows: Array<[string, number, number]> }) {
  return (
    <Card colors={props.colors} minTouchTarget={props.minTouchTarget} title={props.title}>
      {props.rows.length === 0 ? (
        <Text style={{ color: props.colors.textSecondary }}>Nothing in this range.</Text>
      ) : null}
      {props.rows.map(([label, rides, spend]) => (
        <Text key={label} style={{ color: props.colors.textPrimary }} accessibilityRole="text">
          {`${label}: ${rides} ride${rides === 1 ? '' : 's'}, ${formatNpr(spend)}`}
        </Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  group: { gap: 8 },
});
