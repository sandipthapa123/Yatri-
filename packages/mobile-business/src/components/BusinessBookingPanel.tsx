import { ApiError } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import {
  ORG_PURPOSE_MAX,
  orgRoleHolds,
  type OrgBookingBody,
  type OrgBookingPreview,
  type OrgBookingResult,
  type OrgCostCenterInfo,
  type OrgMemberInfo,
  type OrganizationInfo,
  type TripRequestBody,
} from '@yatri/types';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { businessApi } from '../businessApi';
import { previewText } from '../businessText';
import { Field, Problem } from './Field';

/** What the person chose for who pays for this ride: `null` (nothing here) means an ordinary ride, paid in cash. */
export interface BusinessChoice {
  organizationId: string;
  organizationName: string;
  /** The member the ride is for; null is the person themselves. */
  passengerId: string | null;
  passengerName: string | null;
  costCenterId: string | null;
  purpose: string;
  /** The server's policy decision for what is chosen now; null while it is being worked out. */
  preview: OrgBookingPreview | null;
}

/** Send the booking (the one call the apps make for a business ride; the server prices and decides). */
export async function submitBusinessBooking(
  accessToken: string,
  choice: BusinessChoice,
  request: TripRequestBody,
): Promise<OrgBookingResult> {
  const body: OrgBookingBody = {
    ...request,
    ...(choice.passengerId ? { passengerId: choice.passengerId } : {}),
    ...(choice.costCenterId ? { costCenterId: choice.costCenterId } : {}),
    ...(choice.purpose.trim() ? { purpose: choice.purpose.trim() } : {}),
  };
  return businessApi.book(accessToken, choice.organizationId, body);
}

/**
 * "Who pays" for the ride being requested. It appears only for a person who is in an organization that lets them
 * book. Choosing an organization asks who the ride is for (a booker may choose another member), the cost centre
 * and a purpose, and shows what the organization's rules say about THIS ride (from the server) before anything is
 * sent. It decides nothing itself: the booking is made and checked by the server.
 */
export function BusinessBookingPanel(
  props: UiProps & {
    getAccessToken: () => Promise<string>;
    /** The ride as it will be requested, once chosen; null until there is a pickup, destination and type. */
    request: TripRequestBody | null;
    onChange: (choice: BusinessChoice | null) => void;
  },
) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const [news, say] = useNews();
  const mine = usePolled<OrganizationInfo[]>(
    async () => businessApi.mine(await props.getAccessToken()),
    null,
  );
  const bookable = (mine.data ?? []).filter(
    (o) =>
      o.status === 'ACTIVE' &&
      (orgRoleHolds(o.myRole, 'RIDES_BOOK_SELF') ||
        orgRoleHolds(o.myRole, 'RIDES_BOOK_FOR_OTHERS')),
  );
  const [orgId, setOrgId] = useState<string | null>(null);
  const org = bookable.find((o) => o.id === orgId) ?? null;
  const [riderId, setRiderId] = useState<string | null>(null);
  const [costCenterId, setCostCenterId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  const [preview, setPreview] = useState<OrgBookingPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [members, setMembers] = useState<OrgMemberInfo[]>([]);
  const [centers, setCenters] = useState<OrgCostCenterInfo[]>([]);
  const canForOthers = !!org && orgRoleHolds(org.myRole, 'RIDES_BOOK_FOR_OTHERS');
  const canSelf = !!org && orgRoleHolds(org.myRole, 'RIDES_BOOK_SELF');

  // The organization's people and cost centres, when one is chosen.
  useEffect(() => {
    if (!org) return;
    let alive = true;
    void (async () => {
      try {
        const t = await props.getAccessToken();
        const [c, m] = await Promise.all([
          businessApi.costCenters(t, org.id),
          canForOthers ? businessApi.members(t, org.id) : Promise.resolve([] as OrgMemberInfo[]),
        ]);
        if (alive) {
          setCenters(c.filter((x) => x.isActive));
          setMembers(m.filter((x) => x.status === 'ACTIVE'));
        }
      } catch {
        /* the lists are optional: booking still works without them */
      }
    })();
    return () => {
      alive = false;
    };
  }, [org?.id]);

  // What the organization's rules say about this ride, whenever the ride or the choices change.
  const requestKey = props.request ? JSON.stringify(props.request) : '';
  useEffect(() => {
    if (!org || !props.request) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreview(null);
    setProblem(null);
    void (async () => {
      try {
        const p = await businessApi.preview(await props.getAccessToken(), org.id, {
          ...props.request!,
          ...(riderId ? { passengerId: riderId } : {}),
          ...(costCenterId ? { costCenterId } : {}),
        });
        if (alive) {
          setPreview(p);
          say(previewText(p));
        }
      } catch (e) {
        if (alive)
          setProblem(e instanceof ApiError ? e.message : 'Could not check the organization rules.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [org?.id, riderId, costCenterId, requestKey]);

  const rider = members.find((m) => m.userId === riderId) ?? null;
  useEffect(() => {
    props.onChange(
      org
        ? {
            organizationId: org.id,
            organizationName: org.name,
            passengerId: riderId,
            passengerName: rider?.name ?? null,
            costCenterId,
            purpose,
            preview,
          }
        : null,
    );
  }, [org?.id, riderId, costCenterId, purpose, preview]);

  if (bookable.length === 0) return null;
  return (
    <Card {...ui} title="Who pays for this ride">
      <Announcer {...ui} polite={news} />
      <View accessibilityRole="radiogroup" style={styles.group}>
        <ActionButton
          {...ui}
          role="radio"
          selected={!org}
          label="I pay the driver in cash"
          onPress={() => {
            setOrgId(null);
            setRiderId(null);
          }}
        />
        {bookable.map((o) => (
          <ActionButton
            key={o.id}
            {...ui}
            role="radio"
            selected={org?.id === o.id}
            label={`Business ride for ${o.name}`}
            onPress={() => {
              setOrgId(o.id);
              setRiderId(null);
              setCostCenterId(null);
            }}
          />
        ))}
      </View>
      {org ? (
        <>
          {canForOthers ? (
            <>
              <Text
                accessibilityRole="header"
                style={{ color: colors.textPrimary, fontWeight: '600' }}
              >
                Who is the ride for?
              </Text>
              <View accessibilityRole="radiogroup" style={styles.group}>
                {canSelf ? (
                  <ActionButton
                    {...ui}
                    role="radio"
                    selected={riderId === null}
                    label="Me"
                    onPress={() => setRiderId(null)}
                  />
                ) : null}
                {members.map((m) => (
                  <ActionButton
                    key={m.userId}
                    {...ui}
                    role="radio"
                    selected={riderId === m.userId}
                    label={m.name ?? 'Unnamed person'}
                    onPress={() => setRiderId(m.userId)}
                  />
                ))}
              </View>
              {riderId ? (
                <Text style={{ color: colors.textSecondary }}>
                  The rider is told, and follows the ride in their own app. You will see it in the
                  organization&apos;s rides.
                </Text>
              ) : null}
            </>
          ) : null}
          {centers.length > 0 ? (
            <>
              <Text
                accessibilityRole="header"
                style={{ color: colors.textPrimary, fontWeight: '600' }}
              >
                Cost centre
              </Text>
              <View accessibilityRole="radiogroup" style={styles.group}>
                <ActionButton
                  {...ui}
                  role="radio"
                  selected={costCenterId === null}
                  label="None (or the rider's default)"
                  onPress={() => setCostCenterId(null)}
                />
                {centers.map((c) => (
                  <ActionButton
                    key={c.id}
                    {...ui}
                    role="radio"
                    selected={costCenterId === c.id}
                    label={`${c.code}, ${c.name}`}
                    onPress={() => setCostCenterId(c.id)}
                  />
                ))}
              </View>
            </>
          ) : null}
          <Field
            {...ui}
            label="Purpose of the ride (optional)"
            value={purpose}
            onChangeText={setPurpose}
            maxLength={ORG_PURPOSE_MAX}
          />
          {preview ? (
            <Text
              accessibilityRole={preview.outcome === 'DENIED' ? 'alert' : 'text'}
              style={{
                color: colors.textPrimary,
                fontWeight: preview.outcome === 'ALLOWED' ? '400' : '700',
              }}
            >
              {previewText(preview)}
            </Text>
          ) : (
            <Text style={{ color: colors.textSecondary }}>
              Checking the organization&apos;s rules…
            </Text>
          )}
          {problem ? <Problem text={problem} color={colors.error} /> : null}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
});
