/**
 * Call quality, MEASURED. Nothing here is a claim about what the network "should" carry:
 * "HD" is reported only when the stats of the running call prove it, over several samples.
 * Until then — and whenever the evidence stops — it reads "standard", never "HD".
 */

export interface RtcStatsSample {
  atMs: number;
  /** Inbound audio from the other person. Null when the stats did not include it. */
  audio: {
    codec: string | null;
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    jitterMs: number | null;
    roundTripMs: number | null;
  } | null;
  /** Inbound video (video calls only). */
  video: {
    frameWidth: number | null;
    frameHeight: number | null;
    framesPerSecond: number | null;
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
  } | null;
}

export type QualityLevel = 'unknown' | 'good' | 'fair' | 'poor';

export interface CallQuality {
  level: QualityLevel;
  audio: 'unknown' | 'standard' | 'hd';
  /** 'off' when this is not a video call or no video is arriving. */
  video: 'off' | 'unknown' | 'standard' | 'hd';
  audioKbps: number | null;
  lossPercent: number | null;
  roundTripMs: number | null;
  jitterMs: number | null;
}

/** The thresholds in one place (they are measurement rules, not deployment tuning). */
export const QUALITY_RULES = {
  poor: { lossPercent: 10, roundTripMs: 600, jitterMs: 80 },
  fair: { lossPercent: 3, roundTripMs: 300, jitterMs: 40 },
  /** Opus at/above this measured bitrate is wideband-or-better speech ("HD voice"). */
  hdAudioKbps: 32,
  hdAudioMaxLossPercent: 2,
  hdVideoHeight: 720,
  hdVideoFps: 24,
  hdVideoMaxLossPercent: 3,
  /** Consecutive agreeing readings before a change is believed. */
  levelStreak: 2,
  hdStreak: 3,
  /** Fewer packets than this in an interval says nothing about loss. */
  minPacketsForLoss: 10,
} as const;

const NONE: CallQuality = {
  level: 'unknown',
  audio: 'unknown',
  video: 'off',
  audioKbps: null,
  lossPercent: null,
  roundTripMs: null,
  jitterMs: null,
};

const pct = (lost: number, received: number) =>
  lost + received <= 0 ? null : (Math.max(0, lost) / (lost + received)) * 100;

/** One reading from two consecutive samples (rates need a delta). */
export function evaluateInterval(prev: RtcStatsSample, cur: RtcStatsSample): CallQuality {
  const seconds = (cur.atMs - prev.atMs) / 1000;
  if (seconds <= 0 || !cur.audio || !prev.audio) return NONE;

  const dRecv = cur.audio.packetsReceived - prev.audio.packetsReceived;
  const dLost = cur.audio.packetsLost - prev.audio.packetsLost;
  const audioKbps = ((cur.audio.bytesReceived - prev.audio.bytesReceived) * 8) / seconds / 1000;
  const loss = dRecv + dLost >= QUALITY_RULES.minPacketsForLoss ? pct(dLost, dRecv) : null;
  const rtt = cur.audio.roundTripMs;
  const jitter = cur.audio.jitterMs;

  let level: QualityLevel = 'good';
  if (dRecv <= 0)
    level = 'poor'; // connected but nothing is arriving
  else {
    const r = QUALITY_RULES;
    if (
      (loss ?? 0) > r.poor.lossPercent ||
      (rtt ?? 0) > r.poor.roundTripMs ||
      (jitter ?? 0) > r.poor.jitterMs
    ) {
      level = 'poor';
    } else if (
      (loss ?? 0) > r.fair.lossPercent ||
      (rtt ?? 0) > r.fair.roundTripMs ||
      (jitter ?? 0) > r.fair.jitterMs
    ) {
      level = 'fair';
    }
  }

  const hdAudio =
    (cur.audio.codec ?? '').toLowerCase().includes('opus') &&
    audioKbps >= QUALITY_RULES.hdAudioKbps &&
    (loss ?? 0) <= QUALITY_RULES.hdAudioMaxLossPercent &&
    level === 'good';

  let video: CallQuality['video'] = 'off';
  if (cur.video && prev.video) {
    const vRecv = cur.video.packetsReceived - prev.video.packetsReceived;
    const vLoss = pct(cur.video.packetsLost - prev.video.packetsLost, vRecv);
    const h = cur.video.frameHeight;
    const fps = cur.video.framesPerSecond;
    if (vRecv <= 0 || h === null || fps === null) video = 'unknown';
    else
      video =
        h >= QUALITY_RULES.hdVideoHeight &&
        fps >= QUALITY_RULES.hdVideoFps &&
        (vLoss ?? 0) <= QUALITY_RULES.hdVideoMaxLossPercent
          ? 'hd'
          : 'standard';
  }

  return {
    level,
    audio: hdAudio ? 'hd' : 'standard',
    video,
    audioKbps: Math.round(audioKbps),
    lossPercent: loss === null ? null : Math.round(loss * 10) / 10,
    roundTripMs: rtt === null ? null : Math.round(rtt),
    jitterMs: jitter === null ? null : Math.round(jitter),
  };
}

/**
 * Smooths readings so the UI and announcements do not flap: a level change, and any HD claim,
 * needs consecutive agreeing readings; losing HD is immediate (never overstate).
 */
export class QualityTracker {
  private prev: RtcStatsSample | null = null;
  private current: CallQuality = NONE;
  private candidateLevel: QualityLevel | null = null;
  private levelRun = 0;
  private hdAudioRun = 0;
  private hdVideoRun = 0;

  /** Feed one stats sample; returns the smoothed quality. */
  update(sample: RtcStatsSample): CallQuality {
    const prev = this.prev;
    this.prev = sample;
    if (!prev) return this.current;
    const r = evaluateInterval(prev, sample);
    if (r.level === 'unknown') return this.current;

    // level: believe a change only after it repeats (worsening is believed one reading sooner)
    if (r.level === this.current.level) {
      this.candidateLevel = null;
      this.levelRun = 0;
    } else {
      if (this.candidateLevel === r.level) this.levelRun++;
      else {
        this.candidateLevel = r.level;
        this.levelRun = 1;
      }
      const worse = rank(r.level) < rank(this.current.level) && this.current.level !== 'unknown';
      const needed = this.current.level === 'unknown' ? 1 : worse ? 1 : QUALITY_RULES.levelStreak;
      if (this.levelRun >= needed) {
        this.current = { ...this.current, level: r.level };
        this.candidateLevel = null;
        this.levelRun = 0;
      }
    }

    this.hdAudioRun = r.audio === 'hd' ? this.hdAudioRun + 1 : 0;
    this.hdVideoRun = r.video === 'hd' ? this.hdVideoRun + 1 : 0;
    this.current = {
      ...this.current,
      audio: this.hdAudioRun >= QUALITY_RULES.hdStreak ? 'hd' : 'standard',
      video:
        r.video === 'hd'
          ? this.hdVideoRun >= QUALITY_RULES.hdStreak
            ? 'hd'
            : 'standard'
          : r.video,
      audioKbps: r.audioKbps,
      lossPercent: r.lossPercent,
      roundTripMs: r.roundTripMs,
      jitterMs: r.jitterMs,
    };
    return this.current;
  }

  get quality(): CallQuality {
    return this.current;
  }
}

const rank = (l: QualityLevel) => ({ unknown: 3, good: 3, fair: 2, poor: 1 })[l];

/** Words for the quality, for screen readers and the on-screen label (never colour alone). */
export function describeQuality(q: CallQuality, isVideoCall: boolean): string {
  if (q.level === 'unknown') return 'Checking call quality.';
  const level = { good: 'Good connection', fair: 'Fair connection', poor: 'Poor connection' }[
    q.level
  ];
  const audio = q.audio === 'hd' ? 'HD audio' : 'Standard audio';
  const video =
    !isVideoCall || q.video === 'off'
      ? ''
      : q.video === 'hd'
        ? ', HD video'
        : q.video === 'standard'
          ? ', standard video'
          : ', video not arriving';
  return `${level}. ${audio}${video}.`;
}
