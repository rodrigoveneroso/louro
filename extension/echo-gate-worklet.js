// Runs EchoGate on the audio thread. Input 0 is the microphone, input 1 the meeting tab
// (the reference), output is the microphone with the echo taken out.
import { EchoGate } from './echo-gate.js';

class EchoGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gate = new EchoGate({ sampleRate }); // sampleRate is a global of this scope
    this.far = new Float32Array(128);
    this.port.onmessage = ({ data }) => {
      if (data && 'enabled' in data) this.gate.setEnabled(data.enabled);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const mic = inputs[0][0];
    if (!output.length) return true;
    if (!mic) {
      output.forEach((channel) => channel.fill(0));
      return true;
    }

    output[0].set(mic);
    this.gate.process(output[0], this.mono(inputs[1]));
    for (let c = 1; c < output.length; c++) output[c].set(output[0]);
    return true;
  }

  /** The tab's channels averaged, or nothing while it is silent or disconnected. */
  mono(channels) {
    if (!channels || !channels.length) return undefined;
    if (channels.length === 1) return channels[0];
    if (this.far.length !== channels[0].length) this.far = new Float32Array(channels[0].length);
    this.far.fill(0);
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i++) this.far[i] += channel[i] / channels.length;
    }
    return this.far;
  }
}

registerProcessor('echo-gate', EchoGateProcessor);
