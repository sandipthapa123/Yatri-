import type { UiProps } from '@yatri/mobile-ride';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { pickEvidenceFile } from '../pickEvidenceFile';
import { NewRequestForm } from './NewRequestForm';
import { PrivacyPanel } from './PrivacyPanel';
import { SupportHome } from './SupportHome';
import { TicketThread } from './TicketThread';

type View =
  | { name: 'home' }
  | { name: 'new'; tripId: string | null }
  | { name: 'ticket'; id: string }
  | { name: 'privacy' };

/**
 * Support for both apps, as one screen with its own small set of views: the list, a new request (for a
 * ride when `tripId` is given), one conversation and privacy. Both apps show exactly this, so passenger and
 * driver can never drift apart. Leaving a view puts a person back where they came from.
 */
export function SupportCenter(
  props: UiProps & {
    getAccessToken: () => Promise<string>;
    /** Open straight into a new problem report for this ride. */
    tripId?: string | null;
    /** Open straight into this conversation (for example from a notification). */
    ticketId?: string | null;
    /** Leave support altogether (back to the screen that opened it). */
    onExit: () => void;
    emergencyNumber?: string;
  },
) {
  const { colors, minTouchTarget, getAccessToken } = props;
  const ui = { colors, minTouchTarget };
  const [view, setView] = useState<View>(
    props.ticketId
      ? { name: 'ticket', id: props.ticketId }
      : props.tripId
        ? { name: 'new', tripId: props.tripId }
        : { name: 'home' },
  );
  const home = () => setView({ name: 'home' });
  // A request raised from a ride goes back to the ride when abandoned, and to the list otherwise.
  const leaveNew = props.tripId ? props.onExit : home;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {view.name === 'home' ? (
        <SupportHome
          {...ui}
          getAccessToken={getAccessToken}
          onNew={() => setView({ name: 'new', tripId: null })}
          onOpen={(id) => setView({ name: 'ticket', id })}
          onPrivacy={() => setView({ name: 'privacy' })}
        />
      ) : null}
      {view.name === 'new' ? (
        <NewRequestForm
          {...ui}
          getAccessToken={getAccessToken}
          tripId={view.tripId}
          emergencyNumber={props.emergencyNumber}
          onCreated={(t) => setView({ name: 'ticket', id: t.id })}
          onCancel={leaveNew}
        />
      ) : null}
      {view.name === 'ticket' ? (
        <TicketThread
          {...ui}
          getAccessToken={getAccessToken}
          ticketId={view.id}
          pickFile={pickEvidenceFile}
          onBack={home}
        />
      ) : null}
      {view.name === 'privacy' ? (
        <PrivacyPanel {...ui} getAccessToken={getAccessToken} onBack={home} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ content: { padding: 16, gap: 12 } });
