import { ApiError } from '@yatri/mobile-auth';
import {
  BROADCAST_MESSAGES,
  LiveTripView,
  useLiveTrip,
  useLocationBroadcast,
} from '@yatri/mobile-location';
import {
  ACTIVE_TRIP_STATUSES,
  ASSIGNED_TRIP_STATUSES,
  OPEN_SOS_STATES,
  TERMINAL_TRIP_STATUSES,
  counterpartLabel,
  hasAccessibilityContent,
  type TripRole,
  type TripSummary,
} from '@yatri/types';
import { useUiPreferences } from '@yatri/mobile-ui';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useCall, useChat, useSos } from '../hooks';
import { businessText, rideActions, type RideActionId } from '../rideActions';
import { rideApi } from '../rideApi';
import { AccessibilityRideCard } from './AccessibilityRideCard';
import { CallPanel } from './CallPanel';
import { PickupGuideCard } from './PickupGuideCard';
import { CounterpartCard } from './CounterpartCard';
import { NavigateButton } from './NavigateButton';
import { ChatPanel } from './ChatPanel';
import { IncidentForm } from './IncidentForm';
import { SosPanel } from './SosPanel';
import { PostRidePanel } from './PostRidePanel';
import { TripSharePanel } from './TripSharePanel';
import { ActionButton, Announcer, type RideColors } from './RideUi';

type Tab = 'trip' | 'chat' | 'call';

export interface RideRoomProps {
  tripId: string;
  role: TripRole;
  getAccessToken: () => Promise<string>;
  colors: RideColors;
  minTouchTarget: number;
  /** Leave the ride screen (back to home). */
  onExit: () => void;
  /** Open the support screen for a problem with this ride (ride problems are support tickets). */
  onReportProblem: (tripId: string) => void;
}

/** Refetch the trip summary (payment, rating, fare) whenever the ride visibly moves on. */
function useTripSummary(tripId: string, getAccessToken: () => Promise<string>, key: string) {
  const [trip, setTrip] = useState<TripSummary | null>(null);
  const reload = useCallback(async () => {
    try {
      setTrip(await rideApi.trip(await getAccessToken(), tripId));
    } catch {
      /* the live view still works; actions that need the summary wait for it */
    }
  }, [tripId, getAccessToken]);
  useEffect(() => {
    void reload();
  }, [reload, key]);
  return { trip, reload };
}

/**
 * One ride, for either side: live status and location (with the waiting timer), chat, calls, the
 * actions the ride allows right now, and the wrap-up (payment, rating, report a problem).
 * Both apps render THIS — the roles differ only in which actions the server would accept.
 * Chat and call news is announced from here, above the tabs, so an incoming call or message is
 * heard whichever tab is showing.
 */
export function RideRoom(props: RideRoomProps) {
  const { tripId, role, getAccessToken, colors, minTouchTarget, onExit, onReportProblem } = props;
  const ui = { colors, minTouchTarget };
  const live = useLiveTrip(tripId, getAccessToken, role);
  const status = live.snapshot?.status ?? null;
  const { trip, reload } = useTripSummary(
    tripId,
    getAccessToken,
    `${status}:${live.events.length}`,
  );
  const chat = useChat({ socket: live.socket, tripId, role, getAccessToken });
  const call = useCall({ socket: live.socket, tripId, role, getAccessToken });
  const sos = useSos({ socket: live.socket, tripId, getAccessToken });

  const [tab, setTab] = useState<Tab>('trip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'rate' | 'incident' | null>(null);
  const [reportNews, setReportNews] = useState<{ id: number; text: string } | null>(null);
  const [share, setShare] = useState(false);
  // Simpler screens: during a ride only the essentials show; trip sharing and accessibility details sit behind a button.
  const { simplifiedNavigation: simplified } = useUiPreferences();
  const [more, setMore] = useState(false);
  const showMore = !simplified || more;

  // An incoming call is urgent: bring it to the front (it was also announced assertively).
  const incoming = call.state.phase === 'incoming';
  useEffect(() => {
    if (incoming) setTab('call');
  }, [incoming]);

  // The groups of states are defined once, in @yatri/types.
  const active = status !== null && ACTIVE_TRIP_STATUSES.includes(status);
  const assigned = status !== null && ASSIGNED_TRIP_STATUSES.includes(status);
  const canShare = role === 'PASSENGER' && status === 'DRIVER_EN_ROUTE';
  const broadcast = useLocationBroadcast({
    client: live.client,
    kind: 'passenger_location',
    enabled: share && canShare,
  });
  const left = live.connection === 'ended' && role === 'DRIVER' && !assigned;

  const actions = rideActions(
    role,
    {
      status: trip?.status ?? status ?? 'SEARCHING',
      paymentStatus: trip?.paymentStatus ?? 'NONE',
      rated: trip?.rated ?? false,
      cancelFeeNpr: trip?.cancelFeeNpr ?? 0,
      billedToOrganization: trip?.business?.billedToOrganization ?? false,
    },
    live.snapshot?.waiting ?? null,
  );

  const perform = async (id: RideActionId) => {
    if (id === 'dispute') {
      onReportProblem(tripId);
      return;
    }
    if (id === 'rate' || id === 'incident') {
      setForm(id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (id === 'cancel') await rideApi.cancel(token, tripId);
      else if (id === 'arrived') await rideApi.arrived(token, tripId);
      else if (id === 'start') await rideApi.start(token, tripId);
      else if (id === 'complete') await rideApi.complete(token, tripId);
      else if (id === 'noShow') await rideApi.noShow(token, tripId);
      else if (id === 'confirmPayment') await rideApi.confirmPayment(token, tripId);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onAction = (id: RideActionId) => {
    const a = actions.find((x) => x.id === id);
    if (a?.confirm) {
      Alert.alert(a.confirm.title, a.confirm.message, [
        { text: 'Go back', style: 'cancel' },
        {
          text: a.label,
          style: a.tone === 'danger' ? 'destructive' : 'default',
          onPress: () => void perform(id),
        },
      ]);
    } else void perform(id);
  };

  const submit = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setForm(null);
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Please try again.');
      return false;
    }
  };

  const ended = status !== null && TERMINAL_TRIP_STATUSES.includes(status);
  const sosOpen = sos.state.sos !== null && OPEN_SOS_STATES.includes(sos.state.sos.status);
  const reporting = form === 'incident';
  const unread = chat.state.unreadCount;
  const chatLabel =
    unread > 0 ? `Chat, ${unread} unread ${unread === 1 ? 'message' : 'messages'}` : 'Chat';
  const callLabel =
    call.state.phase === 'incoming'
      ? 'Call, incoming'
      : call.state.phase === 'connected'
        ? 'Call, in progress'
        : 'Call';

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {/* Announcements live above the tabs so they are heard from any tab. */}
      <Announcer {...ui} polite={chat.state.announcement} />
      <Announcer {...ui} polite={call.state.polite} assertive={call.state.assertive} />
      <Announcer {...ui} polite={reportNews} />

      {left ? (
        <View style={styles.block}>
          <Text accessibilityRole="header" style={[styles.h, { color: colors.textPrimary }]}>
            This ride is no longer yours
          </Text>
          <ActionButton {...ui} label="Back to home" tone="primary" onPress={onExit} />
        </View>
      ) : (
        <>
          <View accessibilityRole="tablist" style={styles.tabs}>
            <ActionButton
              {...ui}
              role="tab"
              label="Trip"
              selected={tab === 'trip'}
              onPress={() => setTab('trip')}
            />
            <ActionButton
              {...ui}
              role="tab"
              label={unread > 0 ? `Chat (${unread})` : 'Chat'}
              accessibilityLabel={chatLabel}
              selected={tab === 'chat'}
              onPress={() => setTab('chat')}
            />
            <ActionButton
              {...ui}
              role="tab"
              label={call.state.phase === 'incoming' ? 'Call (incoming)' : 'Call'}
              accessibilityLabel={callLabel}
              selected={tab === 'call'}
              onPress={() => setTab('call')}
            />
          </View>

          {/* Any ongoing call stays reachable from the trip tab. */}
          {tab !== 'call' &&
          (call.state.phase === 'connected' ||
            call.state.phase === 'calling' ||
            call.state.phase === 'connecting') ? (
            <ActionButton
              {...ui}
              label={
                call.state.phase === 'connected'
                  ? 'On a call. Open call controls'
                  : 'Calling. Open call controls'
              }
              onPress={() => setTab('call')}
            />
          ) : null}

          {tab === 'trip' ? (
            <View style={styles.block}>
              {trip?.business ? (
                <Text accessibilityRole="text" style={{ color: colors.textPrimary }}>
                  {businessText(role, trip.business)}
                </Text>
              ) : null}
              {assigned || sosOpen ? (
                <SosPanel {...ui} state={sos.state} controller={sos.controller} />
              ) : null}
              {reporting ? (
                <IncidentForm
                  {...ui}
                  emergencyNumber={sos.state.sos?.emergencyNumber}
                  onCancel={() => setForm(null)}
                  onSubmit={(body) =>
                    submit(async () => {
                      await rideApi.reportIncident(await getAccessToken(), tripId, body);
                      setReportNews((n) => ({
                        id: (n?.id ?? 0) + 1,
                        text: 'Your report was sent. The safety team will review it.',
                      }));
                    })
                  }
                />
              ) : null}
              {trip?.counterpart && !ended ? (
                <CounterpartCard {...ui} counterpart={trip.counterpart} viewer={role} />
              ) : null}
              {role === 'PASSENGER' &&
              live.snapshot &&
              trip &&
              hasAccessibilityContent(trip.accessibility) ? (
                <PickupGuideCard
                  {...ui}
                  snapshot={live.snapshot}
                  vehicle={trip.counterpart?.vehicle ?? null}
                />
              ) : null}
              {trip && !ended && (showMore || role === 'DRIVER') ? (
                <AccessibilityRideCard
                  {...ui}
                  trip={trip}
                  role={role}
                  getAccessToken={getAccessToken}
                  onChanged={reload}
                />
              ) : null}
              <LiveTripView
                live={live}
                viewer={role}
                colors={colors}
                minTouchTarget={minTouchTarget}
                notice={share && canShare ? BROADCAST_MESSAGES[broadcast.status] || null : null}
              >
                {error && !ended ? (
                  <Text accessibilityRole="alert" style={{ color: colors.error }}>
                    {error}
                  </Text>
                ) : null}

                {canShare && showMore ? (
                  <ActionButton
                    {...ui}
                    role="switch"
                    selected={share}
                    label={
                      share
                        ? 'Sharing my location with the driver'
                        : 'Share my location with the driver'
                    }
                    hint="Helps your driver find you. Stops automatically when the driver arrives."
                    onPress={() => {
                      if (share) live.client?.stopSharing();
                      setShare(!share);
                    }}
                  />
                ) : null}

                {status === 'DRIVER_ARRIVED' ? (
                  // The driver is at the pickup: talking to each other is one tap away.
                  <>
                    <ActionButton
                      {...ui}
                      label={`Message ${counterpartLabel(role)}`}
                      onPress={() => setTab('chat')}
                    />
                    <ActionButton
                      {...ui}
                      label={`Call ${counterpartLabel(role)}`}
                      hint="Opens the call controls"
                      onPress={() => setTab('call')}
                    />
                  </>
                ) : null}
                {role === 'PASSENGER' && assigned && simplified && !more ? (
                  <ActionButton
                    {...ui}
                    label="More options"
                    hint="Shows trip sharing, location sharing and your accessibility details"
                    onPress={() => setMore(true)}
                  />
                ) : null}
                {role === 'PASSENGER' && assigned && showMore ? (
                  <TripSharePanel {...ui} tripId={tripId} getAccessToken={getAccessToken} />
                ) : null}
                {role === 'DRIVER' && live.snapshot && status === 'DRIVER_EN_ROUTE' ? (
                  <NavigateButton
                    {...ui}
                    target={live.snapshot.pickup}
                    label="Navigate to the pickup"
                  />
                ) : null}
                {role === 'DRIVER' && live.snapshot && status === 'IN_PROGRESS' ? (
                  <NavigateButton
                    {...ui}
                    target={live.snapshot.destination}
                    label="Navigate to the destination"
                  />
                ) : null}

                {active && !reporting
                  ? actions.map((a) => (
                      <ActionButton
                        key={a.id}
                        {...ui}
                        label={a.label}
                        tone={a.tone}
                        disabled={busy}
                        onPress={() => onAction(a.id)}
                      />
                    ))
                  : null}

                {status === 'NO_DRIVERS' ? (
                  <Text
                    accessibilityRole="text"
                    style={{ color: colors.textPrimary, fontSize: 17 }}
                  >
                    No drivers are available right now. Please try again in a moment.
                  </Text>
                ) : null}
              </LiveTripView>

              {ended && trip && !reporting ? (
                <PostRidePanel
                  {...ui}
                  trip={trip}
                  role={role}
                  actions={actions}
                  busy={busy}
                  error={error}
                  form={form}
                  onForm={setForm}
                  onAction={onAction}
                  onRate={(stars, comment) =>
                    submit(async () =>
                      rideApi.rate(await getAccessToken(), tripId, {
                        stars,
                        comment: comment.trim() || null,
                      }),
                    )
                  }
                />
              ) : null}

              {ended ? <ActionButton {...ui} label="Back to home" onPress={onExit} /> : null}
            </View>
          ) : null}

          {tab === 'chat' ? (
            <ChatPanel {...ui} state={chat.state} controller={chat.controller} role={role} />
          ) : null}
          {tab === 'call' ? (
            <CallPanel
              {...ui}
              state={call.state}
              controller={call.controller}
              role={role}
              canCall={assigned}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  block: { gap: 14 },
  tabs: { gap: 8 },
  h: { fontSize: 20, fontWeight: '700' },
});
