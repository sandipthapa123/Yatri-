'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { styles } from '../styles';

interface TabDef {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * WAI-ARIA APG "tabs" pattern: roving tabindex, arrow keys move focus and
 * activate the tab (manual activation isn't needed here — each panel is
 * cheap, pre-rendered content, not a fetch), Home/End jump to the ends.
 * The actual data was already fetched server-side; this component only
 * switches which pre-rendered panel is visible.
 */
export function DriverTabs({ tabs }: { tabs: TabDef[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const reactId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function activate(index: number) {
    const clamped = (index + tabs.length) % tabs.length;
    setActiveIndex(clamped);
    tabRefs.current[clamped]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        activate(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        activate(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        activate(0);
        break;
      case 'End':
        event.preventDefault();
        activate(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div>
      <div role="tablist" aria-label="Driver details" style={styles.tabList}>
        {tabs.map((tab, index) => {
          const selected = index === activeIndex;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              role="tab"
              id={`${reactId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${reactId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              style={selected ? { ...styles.tab, ...styles.tabActive } : styles.tab}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${reactId}-panel-${tab.id}`}
          aria-labelledby={`${reactId}-tab-${tab.id}`}
          hidden={index !== activeIndex}
          style={{ paddingTop: 20 }}
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
