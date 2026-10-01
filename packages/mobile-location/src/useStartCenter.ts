import { useEffect, useState } from 'react';

import { serviceApi } from './locationApi';
import { startCenterOf } from './startCenter';

/**
 * Where a map should start, from the platform's cities (null until known, or when none is configured, in which case the
 * picker starts on the whole country). One hook for every screen that shows the picker, so none names a place itself.
 */
export function useStartCenter(): { latitude: number; longitude: number } | null {
  const [center, setCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void serviceApi
      .config()
      .then((c) => alive && setCenter(startCenterOf(c)))
      .catch(() => undefined); // the map then starts on the whole country
    return () => {
      alive = false;
    };
  }, []);
  return center;
}
