/**
 * Echo suppression for the microphone, the way a speakerphone does it.
 *
 * Without headphones the microphone also picks up the meeting coming out of the
 * speakers, and the transcript gets the others twice: once from the tab, once as echo.
 * The tab's own audio is the reference: while it is playing, whatever the microphone
 * hears at a level the speakers could explain is echo and is muted; your voice gets
 * through when it is clearly louder than the echo would be. With the tab silent the
 * microphone is always open, and with headphones (no echo at all) it effectively always
 * is.
 *
 * How loud the echo is depends on the room, the speakers and their volume, so the ratio
 * between the two is learned as it goes, from their envelopes (instant levels would read
 * every pause between syllables as "no echo"). It follows the low end of the ratios seen
 * while the tab plays, which are the moments the microphone hears only echo, and almost
 * stops learning while you talk over someone.
 *
 * Pure and synchronous, so the AudioWorklet that hosts it and the tests share it.
 */
export class EchoGate {
  constructor({
    sampleRate = 48000,
    frameMs = 10,
    farThreshold = 0.003, // tab level below which nothing can echo
    noiseFloor = 0.002, // microphone level that is just room noise
    margin = 2, // how far above the expected echo your voice must be (6 dB)
    tailDecay = 0.92, // per frame: the echo outlasts the sound by the room's reverb
    maxDelayMs = 250, // playback latency plus the trip from speakers to microphone
    holdMs = 300, // keep the microphone open across the gaps between words
    fadeMs = 40, // open and close without clicks
  } = {}) {
    this.frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    this.farThreshold = farThreshold;
    this.noiseFloor = noiseFloor;
    this.margin = margin;
    this.tailDecay = tailDecay;
    this.holdFrames = Math.round(holdMs / frameMs);
    // recent levels: echo can still be arriving from any of the tab's, and the
    // microphone's are read over the same window so the two compare like for like
    const window = Math.max(1, Math.round(maxDelayMs / frameMs));
    this.recentFar = new Float32Array(window);
    this.recentMic = new Float32Array(window);
    this.recentAt = 0;
    this.step = 1 / Math.max(1, Math.round((sampleRate * fadeMs) / 1000));

    // Learned microphone/tab ratio of the echo. It starts as if the speakers were very
    // loud and comes down within a second of hearing the room: starting low instead
    // would mistake a loud echo for your voice and never learn otherwise.
    this.coupling = 2;
    this.farEnvelope = 0;
    this.micEnvelope = 0;
    this.hold = 0;
    this.gain = 1;
    this.target = 1;
    this.enabled = true; // false while you are muted in the meeting

    this.micEnergy = 0;
    this.farEnergy = 0;
    this.filled = 0;
  }

  /** Mute the microphone entirely, e.g. while you are muted in the meeting. */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  /**
   * Process one block in place: `mic` becomes what may be recorded. `far` is the tab's
   * audio over the same block (may be shorter or missing when the tab is silent).
   */
  process(mic, far) {
    for (let i = 0; i < mic.length; i++) {
      const f = far && i < far.length ? far[i] : 0;
      this.micEnergy += mic[i] * mic[i];
      this.farEnergy += f * f;
      if (++this.filled === this.frameSize) this.decide();

      // ramp towards the decision of the last frame
      if (this.gain < this.target) this.gain = Math.min(this.target, this.gain + this.step);
      else if (this.gain > this.target) this.gain = Math.max(this.target, this.gain - this.step);
      mic[i] *= this.gain;
    }
  }

  decide() {
    const micLevel = Math.sqrt(this.micEnergy / this.filled);
    const farLevel = Math.sqrt(this.farEnergy / this.filled);
    this.micEnergy = this.farEnergy = this.filled = 0;

    this.recentFar[this.recentAt] = farLevel;
    this.recentMic[this.recentAt] = micLevel;
    this.recentAt = (this.recentAt + 1) % this.recentFar.length;
    this.farEnvelope = Math.max(loudest(this.recentFar), this.farEnvelope * this.tailDecay);
    this.micEnvelope = Math.max(loudest(this.recentMic), this.micEnvelope * this.tailDecay);
    const farActive = this.farEnvelope > this.farThreshold;

    const echo = this.coupling * this.farEnvelope;
    const speaking = micLevel > this.noiseFloor && micLevel > this.margin * echo;
    // the pauses between your words still carry your voice in the envelope
    if (farActive) this.learn(this.micEnvelope / this.farEnvelope, speaking || this.hold > 0);

    if (!this.enabled) {
      this.hold = 0;
      this.target = 0;
    } else if (!farActive || speaking) {
      this.hold = this.holdFrames;
      this.target = 1;
    } else if (this.hold > 0) {
      this.hold--;
    } else {
      this.target = 0;
    }
  }

  /**
   * Follow the low end of the ratios: down quickly, up slowly. While you talk over
   * someone the ratio is your voice, not the room, so it barely moves then; it still
   * creeps up, in case the speakers really did get louder.
   */
  learn(ratio, speaking) {
    let rate = 0.05;
    if (ratio > this.coupling) rate = speaking ? 0.0005 : 0.005;
    this.coupling += (ratio - this.coupling) * rate;
  }
}

function loudest(levels) {
  let max = 0;
  for (const level of levels) if (level > max) max = level;
  return max;
}
