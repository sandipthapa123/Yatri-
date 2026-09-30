import Link from 'next/link';
import { notFound } from 'next/navigation';
import { describeTripEvent } from '@yatri/types';

import { ApiError, getAdminTripChat } from '../../../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../../../lib/session';
import { styles } from '../../../drivers/styles';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * The conversation on one ride. Reading it needs TRIP_CHAT_VIEW, and every time this page loads
 * the API writes who read which ride's chat to the access log.
 */
export default async function RideChatPage({ params }: PageProps) {
  const accessToken = await requireAdminAccessToken();
  const { id } = await params;
  let chat;
  try {
    chat = await getAdminTripChat(accessToken, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      return (
        <div style={styles.page}>
          <h1 style={styles.title}>Chat is restricted</h1>
          <p role="alert" style={styles.errorText}>
            {e.message}
          </p>
          <Link href={`/rides/${id}`}>← Back to the ride</Link>
        </div>
      );
    }
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Ride conversation</h1>
        <Link href={`/rides/${id}`} style={styles.backLink}>
          ← Back to the ride
        </Link>
      </div>
      <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>
        Reading this conversation has been recorded in the access log.
      </p>
      <ol
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {chat.items.map((item) =>
          item.kind === 'system' ? (
            <li
              key={`e${item.event.seq}`}
              style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}
            >
              {new Date(item.at).toLocaleTimeString()}, ride update:{' '}
              {describeTripEvent(item.event, 'ADMIN')}
            </li>
          ) : (
            <li key={item.message.id} style={{ fontSize: 15 }}>
              <strong>{item.message.senderRole === 'PASSENGER' ? 'Passenger' : 'Driver'}</strong>,{' '}
              {new Date(item.at).toLocaleTimeString()}
              {item.message.readAt ? ', read' : item.message.deliveredAt ? ', delivered' : ''}:{' '}
              {item.message.body}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
