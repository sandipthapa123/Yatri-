import { RANGE_PRESETS, RANGE_PRESET_LABELS, type ResolvedRange } from '@yatri/types';

import { styles } from '../drivers/styles';

/**
 * The date-range control every report and list shares: a preset, or two calendar dates. It is a
 * plain GET form (labelled fields, real submit button), so it works by keyboard and without
 * scripts. Other filters ride along as hidden fields so applying a range keeps them.
 */
export function RangeFilter(props: {
  range?: string;
  from?: string;
  to?: string;
  defaultPreset: string;
  keep?: Record<string, string | undefined>;
  resolved?: ResolvedRange;
}) {
  const custom = !!(props.from || props.to);
  return (
    <form method="get" style={styles.filterForm} role="search" aria-label="Choose the period">
      {Object.entries(props.keep ?? {}).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <div style={styles.field}>
        <label htmlFor="range" style={styles.label}>
          Period
        </label>
        <select
          id="range"
          name="range"
          defaultValue={custom ? '' : (props.range ?? props.defaultPreset)}
          style={styles.select}
        >
          {custom ? <option value="">Custom dates</option> : null}
          {RANGE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {RANGE_PRESET_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <div style={styles.field}>
        <label htmlFor="from" style={styles.label}>
          Or from (date)
        </label>
        <input
          id="from"
          name="from"
          type="date"
          defaultValue={props.from ?? ''}
          style={styles.input}
        />
      </div>
      <div style={styles.field}>
        <label htmlFor="to" style={styles.label}>
          to (date, included)
        </label>
        <input id="to" name="to" type="date" defaultValue={props.to ?? ''} style={styles.input} />
      </div>
      <button type="submit" style={styles.buttonPrimary}>
        Show this period
      </button>
      {props.resolved ? (
        <p style={{ margin: 0, alignSelf: 'center' }}>
          Showing: <strong>{props.resolved.label}</strong> ({props.resolved.timeZone})
        </p>
      ) : null}
    </form>
  );
}

/** Normalise the range-related search params a page received into what the API accepts. */
export function rangeParamsOf(sp: { range?: string; from?: string; to?: string }) {
  // When custom dates are given they win over the preset (the form sends both).
  return sp.from && sp.to
    ? { from: sp.from, to: sp.to }
    : { range: sp.range && sp.range !== '' ? sp.range : undefined };
}
