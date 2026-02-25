import { DeepFilterNet3Core } from './DeepFilterNet3Core';
import type { TrackProcessor, AudioProcessorOptions, Track } from 'livekit-client';
import type { DeepFilterNoiseFilterOptions } from './interfaces';

export type { DeepFilterNoiseFilterOptions };

export class DeepFilterNoiseFilterProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'deepfilternet3-noise-filter';
  processedTrack?: MediaStreamTrack;
  audioContext: AudioContext | null = null;
  sourceNode: MediaStreamAudioSourceNode | null = null;
  workletNode: AudioWorkletNode | null = null;
  destination: MediaStreamAudioDestinationNode | null = null;
  processor: DeepFilterNet3Core;
  enabled = true;
  originalTrack?: MediaStreamTrack;

  private externalAudioContext: AudioContext | null = null;
  private ownsAudioContext = false;
  private sampleRate: number;
  private _isWarmedUp = false;

  constructor(options: DeepFilterNoiseFilterOptions = {}) {
    const cfg = {
      sampleRate: options.sampleRate ?? 48000,
      noiseReductionLevel: options.noiseReductionLevel ?? 80,
      assetConfig: options.assetConfig
    };

    this.sampleRate = cfg.sampleRate;
    this.enabled = options.enabled ?? true;
    this.processor = new DeepFilterNet3Core(cfg);

    if (options.audioContext) {
      this.externalAudioContext = options.audioContext;
    }
  }

  static isSupported(): boolean {
    return typeof AudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  /**
   * Preload / warmup: downloads WASM + model, registers worklet, creates node,
   * waits for READY message from worklet. After this, the processor is fully
   * initialized with bypass=true. Connecting a track is then instant.
   * Safe to call multiple times — only runs once.
   */
  async preload(): Promise<void> {
    if (this._isWarmedUp) return;

    this.ensureAudioContext();

    if (this.audioContext!.state !== 'running') {
      try { await this.audioContext!.resume(); } catch {}
    }

    // Full warmup: WASM download + compile + worklet registration + node creation + wait for READY
    this.workletNode = await this.processor.warmup(this.audioContext!);

    // Create destination now so processedTrack is ready
    if (!this.destination) {
      this.destination = this.audioContext!.createMediaStreamDestination();
      this.processedTrack = this.destination.stream.getAudioTracks()[0];
    }

    this._isWarmedUp = true;
  }

  init = async (opts: { track?: MediaStreamTrack; mediaStreamTrack?: MediaStreamTrack }): Promise<void> => {
    const track = opts.track ?? opts.mediaStreamTrack;
    if (!track) {
      throw new Error('DeepFilterNoiseFilterProcessor.init: missing MediaStreamTrack');
    }
    this.originalTrack = track;

    if (this._isWarmedUp) {
      // Fast path: everything is pre-initialized, just connect the source node
      this.connectSourceTrack(track);
      await this.setEnabled(this.enabled);
    } else {
      // Fallback: full init (cold start)
      await this.ensureGraph();
    }
  };

  restart = async (opts: { track?: MediaStreamTrack; mediaStreamTrack?: MediaStreamTrack }): Promise<void> => {
    const track = opts.track ?? opts.mediaStreamTrack;
    if (track) {
      this.originalTrack = track;
    }

    if (this._isWarmedUp && this.originalTrack) {
      this.connectSourceTrack(this.originalTrack);
      await this.setEnabled(this.enabled);
    } else {
      await this.ensureGraph();
    }
  };

  setEnabled = async (enable: boolean): Promise<boolean> => {
    this.enabled = enable;
    this.processor.setNoiseSuppressionEnabled(enable);
    return this.enabled;
  };

  setSuppressionLevel(level: number): void {
    this.processor.setSuppressionLevel(level);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isNoiseSuppressionEnabled(): boolean {
    return this.processor.isNoiseSuppressionEnabled();
  }

  suspend = async (): Promise<void> => {
    if (this.audioContext && this.audioContext.state === 'running') {
      await this.audioContext.suspend();
    }
  };

  resume = async (): Promise<void> => {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  };

  destroy = async (): Promise<void> => {
    await this.teardownGraph();
    this.processor.destroy();
    this._isWarmedUp = false;
  };

  /**
   * Connect (or reconnect) a source track to the already-initialized graph.
   * This is the fast path — no WASM, no worklet registration, just a source node swap.
   */
  private connectSourceTrack(track: MediaStreamTrack): void {
    if (!this.audioContext || !this.workletNode || !this.destination) {
      throw new Error('Graph not initialized — call preload() first');
    }

    // Disconnect old source if any
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch {}
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([track]));
    this.sourceNode.connect(this.workletNode).connect(this.destination);
  }

  private ensureAudioContext(): void {
    if (!this.audioContext) {
      if (this.externalAudioContext) {
        this.audioContext = this.externalAudioContext;
        this.ownsAudioContext = false;
      } else {
        this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
        this.ownsAudioContext = true;
      }
    }
  }

  /**
   * Full cold-start graph setup (fallback when preload() wasn't called).
   */
  private async ensureGraph(): Promise<void> {
    if (!this.originalTrack) {
      throw new Error('No source track');
    }

    this.ensureAudioContext();

    if (this.audioContext!.state !== 'running') {
      try { await this.audioContext!.resume(); } catch {}
    }

    await this.processor.initialize();

    if (!this.workletNode) {
      const node = await this.processor.createAudioWorkletNode(this.audioContext!);
      this.workletNode = node;
      // Wait for worklet READY even in cold-start path
      await this.processor.waitForReady();
    }

    if (!this.destination) {
      this.destination = this.audioContext!.createMediaStreamDestination();
      this.processedTrack = this.destination.stream.getAudioTracks()[0];
    }

    this.connectSourceTrack(this.originalTrack);
    this._isWarmedUp = true;

    await this.setEnabled(this.enabled);
  }

  private async teardownGraph(): Promise<void> {
    try {
      if (this.workletNode) {
        this.workletNode.disconnect();
        this.workletNode = null;
      }
      if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }
      if (this.destination) {
        this.destination.disconnect();
        this.destination = null;
      }
      // Only close AudioContext if we created it
      if (this.audioContext && this.ownsAudioContext) {
        void this.audioContext.close();
      }
      this.audioContext = null;
    } catch {
      // Ignore disconnect errors
    }
  }
}

export function DeepFilterNoiseFilter(options?: DeepFilterNoiseFilterOptions): DeepFilterNoiseFilterProcessor {
  return new DeepFilterNoiseFilterProcessor(options);
}
