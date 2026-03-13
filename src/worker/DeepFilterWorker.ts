/**
 * DeepFilterWorker — runs WASM processing OFF the audio render thread.
 *
 * Chrome uses a single audio render thread for ALL AudioContexts and tabs.
 * Running df_create() or df_process_frame() on that thread causes buffer
 * underruns → other apps' audio stutters on Windows (WASAPI).
 *
 * This Worker runs on its own thread. The AudioWorklet sends input frames
 * via a MessagePort, this Worker processes them with WASM, and sends
 * processed frames back. The audio thread never touches WASM.
 *
 * Communication: AudioWorklet ←MessagePort→ DeepFilterWorker
 */

import * as wasm_bindgen from '../df3/df';

interface DeepFilterModel {
  handle: number;
  frameLength: number;
}

let model: DeepFilterModel | null = null;
let workletPort: MessagePort | null = null;

// Adaptive suppression state
let adaptiveEnabled = true;

// Limiter settings (dB, 0 -> no attenuation, 100 -> maximum attenuation)
let maxSuppression = 25;  // User's provided suppression level acts as our max suppression on silence
const minSuppression = 10;  // Minimum suppression during active speech
let currentSuppression = maxSuppression;
let rmsSmoothed = 0;

// Dynamic Noise Floor tracking parameters
let noiseFloor = 0.005; 
const noiseFloorAlpha = 0.0005; 

function computeRMS(buf: Float32Array, len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += buf[i] * buf[i];
  }
  return Math.sqrt(sum / len);
}

function adaptSuppression(rms: number): void {
  if (!model) return;

  // 1. Calculate and track background noise floor
  if (rms < noiseFloor * 2.5) {
    noiseFloor = noiseFloor * (1 - noiseFloorAlpha) + rms * noiseFloorAlpha;
  }
  
  const effectiveNoiseFloor = Math.max(noiseFloor, 0.0001);

  // 2. Smooth the instantaneous Audio Signal (RMS)
  const isAttack = rms > rmsSmoothed;
  // React fast when speaking (attack), decay slowly when paused (release)
  const alpha = isAttack ? 0.4 : 0.02; 
  rmsSmoothed = rmsSmoothed * (1 - alpha) + rms * alpha;

  // 3. Signal-to-Noise Ratio (SNR) based Relative Threshold Algorithm
  const SNR = rmsSmoothed / effectiveNoiseFloor;
  const voiceSNRThreshold = 6.0;  // Threshold for definite human voice
  const quietSNRThreshold = 2.0;  // Threshold for absolute silence/ambient noise

  let target: number;

  if (SNR >= voiceSNRThreshold) {
    target = minSuppression;  // User is speaking, reduce suppression to minimize voice distortion
  } else if (SNR <= quietSNRThreshold) {
    target = maxSuppression;  // User is quiet, maximize suppression to mute fans/clicks
  } else {
    // Soft transition zone (interpolate between max and min based on SNR strength)
    const t = (SNR - quietSNRThreshold) / (voiceSNRThreshold - quietSNRThreshold);
    target = maxSuppression - t * (maxSuppression - minSuppression);
  }

  const rounded = Math.floor(target);
  
  // Update state only if changed >= 1dB to avoid jittering
  if (Math.abs(rounded - currentSuppression) >= 1) {
    currentSuppression = rounded;
    wasm_bindgen.df_set_atten_lim(model.handle, rounded);
  }
}

function processFrame(input: Float32Array): Float32Array {
  if (!model) return input;

  if (adaptiveEnabled) {
    adaptSuppression(computeRMS(input, input.length));
  }

  return wasm_bindgen.df_process_frame(model.handle, input);
}

// Handle messages from main thread (init, config) and worklet (audio frames)
self.onmessage = (event: MessageEvent) => {
  const { type } = event.data;

  switch (type) {
    case 'INIT': {
      // Initialize WASM and create model — this is the heavy part
      // Running here instead of audio thread prevents WASAPI buffer underruns
      const { wasmModule, modelBytes, suppressionLevel } = event.data;
      try {
        wasm_bindgen.initSync(wasmModule);
        const bytes = new Uint8Array(modelBytes);
        const handle = wasm_bindgen.df_create(bytes, suppressionLevel ?? 50);
        const frameLength = wasm_bindgen.df_get_frame_length(handle);

        // Post filter beta — artifact'leri (robotlaşma, metalik ses) yumuşatır
        // 0 = kapalı, 0.02-0.03 arası iyi denge sağlar
        const postFilterBeta = event.data.postFilterBeta ?? 0.02;
        if (postFilterBeta > 0) {
          wasm_bindgen.df_set_post_filter_beta(handle, postFilterBeta);
        }

        model = { handle, frameLength };
        maxSuppression = suppressionLevel ?? 50;
        currentSuppression = maxSuppression;

        (self as any).postMessage({ type: 'READY', frameLength });
      } catch (error) {
        (self as any).postMessage({ type: 'ERROR', error: String(error) });
      }
      break;
    }

    case 'SET_PORT': {
      // Receive MessagePort for direct communication with AudioWorklet
      workletPort = event.data.port;
      workletPort!.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'FRAME') {
          // Process audio frame and send back
          const processed = processFrame(e.data.samples);
          workletPort!.postMessage(
            { type: 'PROCESSED', samples: processed },
            [processed.buffer] // Transfer ownership — zero-copy
          );
        }
      };
      break;
    }

    case 'SET_SUPPRESSION_LEVEL': {
      const level = Math.max(0, Math.min(100, Math.floor(event.data.value)));
      maxSuppression = level;
      if (!adaptiveEnabled && model) {
        currentSuppression = level;
        wasm_bindgen.df_set_atten_lim(model.handle, level);
      }
      break;
    }

    case 'SET_ADAPTIVE': {
      adaptiveEnabled = Boolean(event.data.value);
      if (!adaptiveEnabled && model) {
        currentSuppression = maxSuppression;
        wasm_bindgen.df_set_atten_lim(model.handle, maxSuppression);
      }
      break;
    }

    case 'SET_POST_FILTER_BETA': {
      const beta = Math.max(0, Math.min(0.05, Number(event.data.value) || 0));
      if (model) {
        wasm_bindgen.df_set_post_filter_beta(model.handle, beta);
      }
      break;
    }
  }
};
