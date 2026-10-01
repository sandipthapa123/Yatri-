import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import {
  ORG_PAYMENT_MODES,
  ORG_PAYMENT_MODE_LABELS,
  describeOrgPolicy,
  type OrgCostCenterInfo,
  type OrgPolicy,
  type OrgPolicyView,
  type OrganizationInfo,
} from '@yatri/types';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { parseLimit } from '../businessText';
import { Field, Problem } from './Field';

/**
 * The organization's rules, in words for everyone, with a form for those who may change them. The server
 * checks and applies every rule (`evaluateBooking`) when a ride is booked; this only edits the values.
 */
export function PolicySection(
  props: UiProps & { org: OrganizationInfo; getAccessToken: () => Promise<string> },
) {
  const { colors, minTouchTarget, org } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const policy = usePolled<OrgPolicyView>(
    async () => businessApi.policy(await props.getAccessToken(), org.id),
    null,
  );
  const [editing, setEditing] = useState(false);
  const canEdit = org.myPermissions.includes('ORG_MANAGE');

  const names = policy.data
    ? {
        categories: Object.fromEntries(policy.data.categoryOptions.map((c) => [c.code, c.label])),
        zones: Object.fromEntries(policy.data.zoneOptions.map((z) => [z.id, z.name])),
      }
    : {};
  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />
      <Card {...ui} title="Rules for rides">
        {policy.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
        {policy.error ? <Problem text={policy.error} color={colors.error} /> : null}
        {policy.data
          ? describeOrgPolicy(policy.data, names).map((line) => (
              <Text key={line} style={{ color: colors.textPrimary }} accessibilityRole="text">
                {line}
              </Text>
            ))
          : null}
        {canEdit && policy.data && !editing ? (
          <ActionButton {...ui} label="Change the rules" onPress={() => setEditing(true)} />
        ) : null}
      </Card>
      {editing && policy.data ? (
        <PolicyForm
          {...ui}
          orgId={org.id}
          view={policy.data}
          getAccessToken={props.getAccessToken}
          onDone={async (text) => {
            say(text);
            setEditing(false);
            await policy.reload();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : null}
      <CostCentersCard {...ui} org={org} getAccessToken={props.getAccessToken} />
    </View>
  );
}

function Toggle(props: UiProps & { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <ActionButton
      colors={props.colors}
      minTouchTarget={props.minTouchTarget}
      role="switch"
      selected={props.on}
      label={`${props.label}: ${props.on ? 'yes' : 'no'}`}
      onPress={() => props.set(!props.on)}
    />
  );
}

function PolicyForm(
  props: UiProps & {
    orgId: string;
    view: OrgPolicyView;
    getAccessToken: () => Promise<string>;
    onDone: (text: string) => Promise<void>;
    onCancel: () => void;
  },
) {
  const { colors } = props;
  const ui = { colors: props.colors, minTouchTarget: props.minTouchTarget };
  const v = props.view;
  const text = (n: number | null) => (n === null ? '' : String(n));
  const [perRide, setPerRide] = useState(text(v.perRideLimitNpr));
  const [perMember, setPerMember] = useState(text(v.perMemberMonthlyLimitNpr));
  const [monthly, setMonthly] = useState(text(v.monthlyLimitNpr));
  const [approvalOver, setApprovalOver] = useState(text(v.approvalOverNpr));
  const [approvalAll, setApprovalAll] = useState(v.approvalForAll);
  const [selfBooking, setSelfBooking] = useState(v.memberSelfBooking);
  const [ccRequired, setCcRequired] = useState(v.costCenterRequired);
  const [mode, setMode] = useState(v.paymentMode);
  const [cats, setCats] = useState<string[]>(v.allowedCategoryCodes);
  const [zones, setZones] = useState<string[]>(v.allowedZoneIds);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flip = (list: string[], set: (l: string[]) => void, x: string) =>
    set(list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  const save = async () => {
    const fields = { perRide, perMember, monthly, approvalOver };
    const parsed = Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, parseLimit(t)]));
    const bad: Record<string, string> = {};
    for (const [k, r] of Object.entries(parsed)) if (r && !r.ok) bad[k] = r.message;
    setProblems(bad);
    if (Object.keys(bad).length > 0) return;
    const value = (k: string) => {
      const r = parsed[k];
      return r && r.ok ? r.value : null;
    };
    const body: OrgPolicy = {
      allowedCategoryCodes: cats,
      allowedZoneIds: zones,
      perRideLimitNpr: value('perRide'),
      perMemberMonthlyLimitNpr: value('perMember'),
      monthlyLimitNpr: value('monthly'),
      approvalOverNpr: value('approvalOver'),
      approvalForAll: approvalAll,
      memberSelfBooking: selfBooking,
      costCenterRequired: ccRequired,
      paymentMode: mode,
    };
    setBusy(true);
    setFailure(null);
    try {
      await businessApi.savePolicy(await props.getAccessToken(), props.orgId, body);
      await props.onDone('The rules were saved. They apply to rides booked from now on.');
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card {...ui} title="Change the rules" focusOnMount>
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '600' }}>
        Who pays
      </Text>
      <View accessibilityRole="radiogroup" style={styles.group}>
        {ORG_PAYMENT_MODES.map((m) => (
          <ActionButton
            key={m}
            {...ui}
            role="radio"
            selected={mode === m}
            label={ORG_PAYMENT_MODE_LABELS[m]}
            onPress={() => setMode(m)}
          />
        ))}
      </View>
      <Field
        {...ui}
        label="Limit for one ride (NPR, empty for none)"
        value={perRide}
        onChangeText={setPerRide}
        keyboardType="number-pad"
        error={problems.perRide ?? null}
      />
      <Field
        {...ui}
        label="Limit for each rider each month (NPR)"
        value={perMember}
        onChangeText={setPerMember}
        keyboardType="number-pad"
        error={problems.perMember ?? null}
      />
      <Field
        {...ui}
        label="Limit for the whole organization each month (NPR)"
        value={monthly}
        onChangeText={setMonthly}
        keyboardType="number-pad"
        error={problems.monthly ?? null}
      />
      <Field
        {...ui}
        label="Rides over this fare need approval (NPR)"
        value={approvalOver}
        onChangeText={setApprovalOver}
        keyboardType="number-pad"
        error={problems.approvalOver ?? null}
        hint="Owners and administrators never need approval for their own bookings."
      />
      <Toggle {...ui} label="Every ride needs approval" on={approvalAll} set={setApprovalAll} />
      <Toggle
        {...ui}
        label="Members may book for themselves"
        on={selfBooking}
        set={setSelfBooking}
      />
      <Toggle {...ui} label="A cost centre is required" on={ccRequired} set={setCcRequired} />
      <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '600' }}>
        Vehicle types allowed (none chosen means all)
      </Text>
      {v.categoryOptions.map((c) => (
        <Toggle
          key={c.code}
          {...ui}
          label={c.label}
          on={cats.includes(c.code)}
          set={() => flip(cats, setCats, c.code)}
        />
      ))}
      {v.zoneOptions.length > 0 ? (
        <>
          <Text accessibilityRole="header" style={{ color: colors.textPrimary, fontWeight: '600' }}>
            Areas rides must start and end in (none chosen means anywhere)
          </Text>
          {v.zoneOptions.map((z) => (
            <Toggle
              key={z.id}
              {...ui}
              label={z.name}
              on={zones.includes(z.id)}
              set={() => flip(zones, setZones, z.id)}
            />
          ))}
        </>
      ) : null}
      {failure ? <Problem text={failure} color={colors.error} /> : null}
      <ActionButton
        {...ui}
        label="Save the rules"
        tone="primary"
        busy={busy}
        onPress={() => void save()}
      />
      <ActionButton {...ui} label="Cancel" onPress={props.onCancel} />
    </Card>
  );
}

/** Cost centres: the department tags rides carry, for reports and statements. */
function CostCentersCard(
  props: UiProps & { org: OrganizationInfo; getAccessToken: () => Promise<string> },
) {
  const { colors, minTouchTarget, org } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const list = usePolled<OrgCostCenterInfo[]>(
    async () => businessApi.costCenters(await props.getAccessToken(), org.id),
    null,
  );
  const canEdit = org.myPermissions.includes('ORG_MANAGE');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (work: (t: string) => Promise<unknown>, done: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await work(await props.getAccessToken());
      say(done);
      await list.reload();
    } catch (e) {
      const t = e instanceof ApiError ? e.message : 'That did not work. Please try again.';
      setProblem(t);
      say(t);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    if (!code.trim() || !name.trim()) {
      setProblem('Give the cost centre a short code and a name.');
      return;
    }
    void act(async (t) => {
      await businessApi.addCostCenter(t, org.id, {
        code: code.trim(),
        name: name.trim(),
        department: department.trim() || null,
      });
      setCode('');
      setName('');
      setDepartment('');
    }, 'Cost centre added.');
  };

  return (
    <Card {...ui} title="Cost centres">
      <Announcer {...ui} polite={news} />
      {list.loading ? <Text style={{ color: colors.textSecondary }}>Loading…</Text> : null}
      {list.data && list.data.length === 0 ? (
        <Text style={{ color: colors.textSecondary }}>No cost centres yet.</Text>
      ) : null}
      {list.data?.map((c) => (
        <View key={c.id} style={styles.row}>
          <Text style={{ color: colors.textPrimary }} accessibilityRole="text">
            {`${c.code}, ${c.name}${c.department ? `, ${c.department}` : ''}${c.isActive ? '' : ', not in use'}`}
          </Text>
          {canEdit ? (
            <ActionButton
              {...ui}
              label={c.isActive ? `Stop using ${c.code}` : `Use ${c.code} again`}
              disabled={busy}
              onPress={() =>
                void act(
                  (t) =>
                    businessApi.saveCostCenter(t, org.id, c.id, {
                      code: c.code,
                      name: c.name,
                      department: c.department,
                      isActive: !c.isActive,
                    }),
                  c.isActive ? `${c.code} is no longer offered.` : `${c.code} is offered again.`,
                )
              }
            />
          ) : null}
        </View>
      ))}
      {problem ? <Problem text={problem} color={colors.error} /> : null}
      {canEdit ? (
        <>
          <Field {...ui} label="Code (short)" value={code} onChangeText={setCode} maxLength={20} />
          <Field {...ui} label="Name" value={name} onChangeText={setName} maxLength={100} />
          <Field
            {...ui}
            label="Department (optional)"
            value={department}
            onChangeText={setDepartment}
            maxLength={100}
          />
          <ActionButton
            {...ui}
            label="Add a cost centre"
            tone="primary"
            busy={busy}
            onPress={add}
          />
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  group: { gap: 8 },
  row: { gap: 6 },
});
