'use client';

import type { DocumentSummary } from '@yatri/types';

import { styles } from '../styles';
import { StatusBadge } from '../StatusBadge';
import { ActionButton } from './ActionButton';
import { approveDocumentAction, rejectDocumentAction, viewDocumentAction } from './actions';
import { ReasonDialogForm } from './ReasonDialogForm';

export function DocumentRow({
  document,
  driverId,
}: {
  document: DocumentSummary;
  driverId: string;
}) {
  return (
    <div style={styles.documentRow}>
      <div>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {document.documentType.label}
          {document.vehicleId ? ' (vehicle)' : ''}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {document.originalFilename} · Uploaded{' '}
          {new Date(document.uploadedAt).toLocaleDateString()}
        </p>
        {document.status === 'REJECTED' && document.rejectionReason ? (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-error)' }}>
            Reason: {document.rejectionReason}
          </p>
        ) : null}
        <div style={{ marginTop: 6 }}>
          <StatusBadge status={document.status} />
        </div>
      </div>
      <div style={styles.buttonRow}>
        <ActionButton
          action={viewDocumentAction}
          fields={{ documentId: document.id }}
          label="View document"
          variant="secondary"
        />
        <ActionButton
          action={approveDocumentAction}
          fields={{ driverId, documentId: document.id }}
          label="Approve"
        />
        <ReasonDialogForm
          action={rejectDocumentAction}
          fields={{ driverId, documentId: document.id }}
          triggerLabel="Reject"
          dialogTitle={`Reject ${document.documentType.label}`}
          submitLabel="Reject document"
        />
      </div>
    </div>
  );
}
