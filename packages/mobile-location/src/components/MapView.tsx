import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  WebView as NativeWebView,
  type WebViewMessageEvent,
  type WebViewProps,
} from 'react-native-webview';

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  /** Single visible glyph, e.g. "P" for pickup, "D" for destination, "Y" for you. */
  glyph: string;
  /** Text equivalent. The map is hidden from assistive tech, so this is for the caller's own text UI. */
  label: string;
}

export interface MapColors {
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  primary: string;
  error: string;
}

export interface YatriMapProps {
  center: { latitude: number; longitude: number };
  markers?: MapMarker[];
  zoom?: number;
  /** When set, tapping the map calls this with the tapped coordinates. */
  onPick?: (point: { latitude: number; longitude: number }) => void;
  colors: MapColors;
  minTouchTarget: number;
  height?: number;
}

// Tile source is configuration, not code: swap the provider (self-hosted,
// MapTiler, etc.) by changing this env var. MapLibre/vector tiles would
// replace this component behind the same props.
// The public OpenStreetMap tile server is for light, non-commercial use only; a release build must be
// given its own tile provider (EXPO_PUBLIC_MAP_TILE_URL). Without one, a release build shows no map at
// all (the text places and distances around it carry the same information) rather than quietly
// leaning on a server that forbids that use. Development keeps the public server for convenience.
export function resolveTileUrl(value: string | undefined, isDev: boolean): string | null {
  const configured = value?.trim();
  if (configured) return configured;
  return isDev ? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' : null;
}
declare const __DEV__: boolean | undefined;
const TILE_URL = resolveTileUrl(
  process.env.EXPO_PUBLIC_MAP_TILE_URL,
  typeof __DEV__ === 'undefined' ? true : __DEV__,
);
const TILE_ATTRIBUTION = process.env.EXPO_PUBLIC_MAP_ATTRIBUTION ?? '© OpenStreetMap contributors';
// react-native-webview's class typings collapse to `never` props under React 19; restore the real props type.
type WebViewHandle = { injectJavaScript: (script: string) => void };
const WebView = NativeWebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebViewHandle> }
>;

const READY_TIMEOUT_MS = 10_000;

function buildHtml(tileUrl: string, attribution: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>html,body,#m{height:100%;margin:0}.g{background:#C81E3A;color:#fff;font:700 14px sans-serif;border:2px solid #fff;border-radius:50%;width:28px;height:28px;line-height:24px;text-align:center}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
var map, layer;
function post(o){window.ReactNativeWebView.postMessage(JSON.stringify(o));}
try{
  map=L.map('m',{zoomControl:false,attributionControl:true});
  L.tileLayer(${JSON.stringify(tileUrl)},{maxZoom:19,attribution:${JSON.stringify(attribution)}}).addTo(map);
  layer=L.layerGroup().addTo(map);
  map.on('click',function(e){post({type:'pick',latitude:e.latlng.lat,longitude:e.latlng.lng});});
  map.setView([27.7172,85.324],13);
  post({type:'ready'});
}catch(e){post({type:'error'});}
window.setState=function(s){
  if(!map)return;
  layer.clearLayers();
  s.markers.forEach(function(m){
    L.marker([m.latitude,m.longitude],{keyboard:false,icon:L.divIcon({className:'',html:'<div class="g">'+m.glyph.replace(/[<>&]/g,'')+'</div>',iconSize:[28,28],iconAnchor:[14,14]})}).addTo(layer);
  });
  if(s.recenter){map.setView([s.center.latitude,s.center.longitude],s.zoom);}
};
window.zoomBy=function(d){if(map)map.setZoom(map.getZoom()+d);};
</script></body></html>`;
}

function MapButton({
  label,
  glyph,
  onPress,
  enabled,
  minTouchTarget,
  colors,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  enabled: boolean;
  minTouchTarget: number;
  colors: MapColors;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      style={[
        styles.button,
        {
          minHeight: minTouchTarget,
          minWidth: minTouchTarget,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          opacity: enabled ? 1 : 0.5,
        },
      ]}
    >
      <Text style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}>{glyph}</Text>
    </Pressable>
  );
}

/**
 * Supplementary visual map. It is deliberately hidden from screen readers:
 * everything it shows is available as text elsewhere, and zoom/re-centre
 * are native buttons below it (real, labelled, 44pt targets) rather than
 * controls inside the web canvas.
 */
export function YatriMap({
  center,
  markers = [],
  zoom = 15,
  onPick,
  colors,
  minTouchTarget,
  height = 220,
}: YatriMapProps) {
  const webRef = useRef<WebViewHandle>(null);
  // No configured tile provider in a release build: no map (and no request to a third-party server).
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(TILE_URL ? 'loading' : 'error');
  const [attempt, setAttempt] = useState(0);
  const html = useMemo(() => (TILE_URL ? buildHtml(TILE_URL, TILE_ATTRIBUTION) : ''), []);

  const push = useCallback(
    (recenter: boolean) => {
      const state = { markers, center, zoom, recenter };
      webRef.current?.injectJavaScript(`window.setState(${JSON.stringify(state)});true;`);
    },
    [markers, center, zoom],
  );

  // Give up (with a retry button) if the map library never reports ready — e.g. offline.
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = setTimeout(() => setPhase('error'), READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [phase, attempt]);

  useEffect(() => {
    if (phase === 'ready') push(true);
    // Recentre only when the centre itself moves, not on every marker change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, center.latitude, center.longitude]);

  useEffect(() => {
    if (phase === 'ready') push(false);
  }, [phase, push]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {
        type: string;
        latitude?: number;
        longitude?: number;
      };
      if (msg.type === 'ready') setPhase('ready');
      else if (msg.type === 'error') setPhase('error');
      else if (
        msg.type === 'pick' &&
        typeof msg.latitude === 'number' &&
        typeof msg.longitude === 'number'
      ) {
        onPick?.({ latitude: msg.latitude, longitude: msg.longitude });
      }
    } catch {
      /* ignore malformed messages */
    }
  };

  const zoomIn = useCallback(() => webRef.current?.injectJavaScript('window.zoomBy(1);true;'), []);
  const zoomOut = useCallback(
    () => webRef.current?.injectJavaScript('window.zoomBy(-1);true;'),
    [],
  );
  const recenter = useCallback(() => push(true), [push]);

  const buttonProps = {
    enabled: phase === 'ready',
    minTouchTarget,
    colors,
  };

  return (
    <View>
      <View
        style={[
          styles.frame,
          { height, borderColor: colors.border, backgroundColor: colors.surface },
        ]}
        // The canvas is not an accessible surface; the text UI around it is.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {phase !== 'error' ? (
          <WebView
            key={attempt}
            ref={webRef}
            originWhitelist={['about:*']}
            source={{ html }}
            onMessage={onMessage}
            onError={() => setPhase('error')}
            onHttpError={() => setPhase('error')}
            javaScriptEnabled
            scrollEnabled={false}
            style={styles.web}
          />
        ) : null}
        {phase === 'loading' ? (
          <View style={styles.overlay}>
            <Text style={{ color: colors.textSecondary }}>Loading map…</Text>
          </View>
        ) : null}
      </View>

      {phase === 'error' ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorBox}>
          <Text style={{ color: colors.error }}>
            The map could not load. Everything you need is still available as text.
          </Text>
          <Pressable
            onPress={() => {
              setPhase('loading');
              setAttempt((a) => a + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading the map"
            style={[styles.button, { minHeight: minTouchTarget, borderColor: colors.border }]}
          >
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Retry map</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.controls}>
          <MapButton label="Zoom in" glyph="+" onPress={zoomIn} {...buttonProps} />
          <MapButton label="Zoom out" glyph="−" onPress={zoomOut} {...buttonProps} />
          <MapButton label="Re-center map" glyph="◎" onPress={recenter} {...buttonProps} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: 'transparent' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controls: { flexDirection: 'row', gap: 8, marginTop: 8 },
  button: {
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  errorBox: { marginTop: 8, gap: 8 },
});
