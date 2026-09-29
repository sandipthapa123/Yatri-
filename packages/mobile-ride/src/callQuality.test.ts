import { describe, expect, it } from 'vitest';

import {
  QualityTracker,
  describeQuality,
  evaluateInterval,
  type RtcStatsSample,
} from './callQuality';

/** A sample `t` seconds in, having received `kbps` for `t` seconds at `lossPct` loss. */
function sample(
  t: number,
  o: {
    kbps?: number;
    lossPct?: number;
    rtt?: number | null;
    jitter?: number | null;
    codec?: string | null;
    video?: { h: number; fps: number } | null;
    stalled?: boolean;
  } = {},
): RtcStatsSample {
  const kbps = o.kbps ?? 40;
  const packets = o.stalled ? 0 : t * 50; // 50 packets per second
  const lost = Math.round((packets * (o.lossPct ?? 0)) / 100);
  return {
    atMs: t * 1000,
    audio: {
      codec: o.codec === undefined ? 'audio/opus' : o.codec,
      bytesReceived: o.stalled ? 0 : (kbps * 1000 * t) / 8,
      packetsReceived: packets - lost,
      packetsLost: lost,
      jitterMs: o.jitter === undefined ? 8 : o.jitter,
      roundTripMs: o.rtt === undefined ? 90 : o.rtt,
    },
    video: o.video
      ? {
          frameWidth: (o.video.h * 16) / 9,
          frameHeight: o.video.h,
          framesPerSecond: o.video.fps,
          bytesReceived: t * 100_000,
          packetsReceived: t * 80,
          packetsLost: 0,
        }
      : null,
  };
}

describe('evaluateInterval: what the measurements say', () => {
  it('calls a clean Opus stream at a wideband bitrate good and HD', () => {
    const q = evaluateInterval(sample(10), sample(13));
    expect(q).toMatchObject({ level: 'good', audio: 'hd', video: 'off' });
    expect(q.audioKbps).toBe(40);
  });

  it('does NOT claim HD for a low bitrate, a non-Opus codec, or a lossy line', () => {
    expect(evaluateInterval(sample(10, { kbps: 12 }), sample(13, { kbps: 12 })).audio).toBe(
      'standard',
    );
    expect(
      evaluateInterval(sample(10, { codec: 'audio/PCMU' }), sample(13, { codec: 'audio/PCMU' }))
        .audio,
    ).toBe('standard');
    expect(evaluateInterval(sample(10, { lossPct: 5 }), sample(13, { lossPct: 5 })).audio).toBe(
      'standard',
    );
    expect(evaluateInterval(sample(10, { codec: null }), sample(13, { codec: null })).audio).toBe(
      'standard',
    );
  });

  it('grades loss, round trip and jitter, worst measure wins', () => {
    const level = (o: Parameters<typeof sample>[1]) =>
      evaluateInterval(sample(10, o), sample(13, o)).level;
    expect(level({ lossPct: 5 })).toBe('fair');
    expect(level({ lossPct: 15 })).toBe('poor');
    expect(level({ rtt: 400 })).toBe('fair');
    expect(level({ rtt: 900 })).toBe('poor');
    expect(level({ jitter: 55 })).toBe('fair');
    expect(level({ jitter: 120 })).toBe('poor');
    expect(level({ lossPct: 1, rtt: 900 })).toBe('poor');
  });

  it('treats “connected but nothing arriving” as poor, not as unknown', () => {
    const a = sample(10);
    const b = {
      ...sample(13),
      audio: {
        ...sample(13).audio!,
        packetsReceived: a.audio!.packetsReceived,
        bytesReceived: a.audio!.bytesReceived,
      },
    };
    expect(evaluateInterval(a, b).level).toBe('poor');
  });

  it('has no opinion without two samples or without audio stats', () => {
    expect(evaluateInterval(sample(10), sample(10)).level).toBe('unknown');
    expect(evaluateInterval({ ...sample(10), audio: null }, sample(13)).level).toBe('unknown');
  });

  it('measures video: HD needs real resolution AND frame rate', () => {
    const v = (h: number, fps: number) =>
      evaluateInterval(sample(10, { video: { h, fps } }), sample(13, { video: { h, fps } })).video;
    expect(v(720, 30)).toBe('hd');
    expect(v(1080, 30)).toBe('hd');
    expect(v(480, 30)).toBe('standard');
    expect(v(720, 12)).toBe('standard');
  });
});

describe('QualityTracker: stable, and never overstating', () => {
  const run = (samples: RtcStatsSample[]) => {
    const t = new QualityTracker();
    return samples.map((s) => t.update(s));
  };

  it('claims HD only after several agreeing readings', () => {
    const out = run([sample(0), sample(3), sample(6), sample(9), sample(12)]);
    expect(out.map((q) => q.audio)).toEqual(['unknown', 'standard', 'standard', 'hd', 'hd']);
  });

  it('drops the HD claim immediately when the evidence stops', () => {
    const t = new QualityTracker();
    let last = t.update(sample(0));
    for (const s of [3, 6, 9, 12]) last = t.update(sample(s));
    expect(last.audio).toBe('hd');
    const dropped = t.update({
      ...sample(15),
      audio: {
        ...sample(15).audio!,
        bytesReceived: sample(12).audio!.bytesReceived + 3 * 12 * 125,
      },
    });
    expect(dropped.audio).toBe('standard');
  });

  it('reports worsening at once but recovery only when it repeats', () => {
    const t = new QualityTracker();
    t.update(sample(0));
    expect(t.update(sample(3)).level).toBe('good');
    // a burst of loss: believed immediately
    const lossy = (s: number, base: RtcStatsSample) => ({
      ...sample(s),
      audio: {
        ...sample(s).audio!,
        packetsReceived: base.audio!.packetsReceived + 100,
        packetsLost: base.audio!.packetsLost + 40,
      },
    });
    const bad = lossy(6, sample(3));
    expect(t.update(bad).level).toBe('poor');
    const clean = (s: number, prev: RtcStatsSample): RtcStatsSample => ({
      ...prev,
      atMs: s * 1000,
      audio: {
        ...prev.audio!,
        packetsReceived: prev.audio!.packetsReceived + 150,
        bytesReceived: prev.audio!.bytesReceived + 15_000,
      },
    });
    const c1 = clean(9, bad);
    expect(t.update(c1).level).toBe('poor'); // one good reading is not yet believed
    expect(t.update(clean(12, c1)).level).toBe('good');
  });

  it('describes quality in words, including what is not known', () => {
    expect(
      describeQuality(
        {
          level: 'unknown',
          audio: 'unknown',
          video: 'off',
          audioKbps: null,
          lossPercent: null,
          roundTripMs: null,
          jitterMs: null,
        },
        false,
      ),
    ).toBe('Checking call quality.');
    expect(
      describeQuality(
        {
          level: 'good',
          audio: 'hd',
          video: 'hd',
          audioKbps: 40,
          lossPercent: 0,
          roundTripMs: 80,
          jitterMs: 5,
        },
        true,
      ),
    ).toBe('Good connection. HD audio, HD video.');
    expect(
      describeQuality(
        {
          level: 'poor',
          audio: 'standard',
          video: 'unknown',
          audioKbps: 9,
          lossPercent: 20,
          roundTripMs: 700,
          jitterMs: 90,
        },
        true,
      ),
    ).toBe('Poor connection. Standard audio, video not arriving.');
  });
});
