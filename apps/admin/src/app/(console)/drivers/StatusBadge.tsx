import { statusBadgeStyle, STATUS_LABEL } from './styles';

/**
 * The label text is always rendered, never color alone — the badge's color
 * is a reinforcing cue, not the only way the status is communicated.
 */
export function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status;
  return <span style={statusBadgeStyle(status)}>{label}</span>;
}
