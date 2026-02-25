import { AssetLoader, getAssetLoader } from './asset-loader/AssetLoader';
import { createWorkletModule } from './utils/workerUtils';
import type { ProcessorAssets, DeepFilterNet3ProcessorConfig } from './interfaces';
import { WorkletMessageTypes } from './constants';
// @ts-ignore - Worklet code imported as string via rollup
import workletCode from './worklet/DeepFilterWorklet.ts?worklet-code';
// @ts-ignore - Worker code imported as string via rollup
import workerCode from './worker/DeepFilterWorker.ts?worker-code';

export type { DeepFilterNet3ProcessorConfig };

export class DeepFilterNet3Core {
  private assetLoader: AssetLoader;
  private assets: ProcessorAssets | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private isInitialized = false;
  private bypassEnabled = false;
  private config: DeepFilterNet3ProcessorConfig;

  constructor(config: DeepFilterNet3ProcessorConfig = {}) {
    this.config = {
      sampleRate: config.sampleRate ?? 48000,
      noiseReductionLevel: config.noiseReductionLevel ?? 50,
      assetConfig: config.assetConfig
    };
    this.assetLoader = getAssetLoader(config.assetConfig);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const assetUrls = this.assetLoader.getAssetUrls();
    const [wasmBytes, modelBytes] = await Promise.all([
      this.assetLoader.fetchAsset(assetUrls.wasm),
      this.assetLoader.fetchAsset(assetUrls.model)
    ]);

    const wasmModule = await WebAssembly.compile(wasmBytes);

    this.assets = { wasmModule, modelBytes };
    this.isInitialized = true;
  }

  /**
   * Start the processing Worker and initialize WASM inside it.
   * This runs df_create() on a separate thread — NOT the audio render thread.
   * Returns a promise that resolves with the frameLength when WASM is ready.
   */
  private startWorker(): Promise<number> {
    this.ensureInitialized();
    if (!this.assets) throw new Error('Assets not loaded');

    return new Promise<number>((resolve, reject) => {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      this.worker = new Worker(blobUrl);

      this.worker.onmessage = (event: MessageEvent) => {
        if (event.data.type === 'READY') {
          resolve(event.data.frameLength);
        } else if (event.data.type === 'ERROR') {
          reject(new Error(event.data.error || 'Worker WASM init failed'));
        }
      };

      // Send WASM module + model to Worker for initialization
      this.worker.postMessage({
        type: 'INIT',
        wasmModule: this.assets!.wasmModule,
        modelBytes: this.assets!.modelBytes,
        suppressionLevel: this.config.noiseReductionLevel,
      });
    });
  }

  async createAudioWorkletNode(audioContext: AudioContext): Promise<AudioWorkletNode> {
    this.ensureInitialized();

    await createWorkletModule(audioContext, workletCode);

    // Worklet no longer needs WASM assets — it's just an I/O bridge
    this.workletNode = new AudioWorkletNode(audioContext, 'deepfilter-audio-processor');

    return this.workletNode;
  }

  /**
   * Full warmup: download assets, start Worker (WASM init), register worklet,
   * create node, bridge Worker↔Worklet via MessageChannel.
   *
   * After this resolves, the system is fully ready:
   * - Worker has WASM initialized (df_create done)
   * - Worklet is registered and connected to Worker
   * - Audio render thread was NEVER blocked by WASM
   */
  async warmup(audioContext: AudioContext): Promise<AudioWorkletNode> {
    await this.initialize();

    // Start Worker and init WASM there (off audio thread)
    const frameLength = await this.startWorker();

    // Create worklet node (lightweight — no WASM in constructor)
    const node = await this.createAudioWorkletNode(audioContext);

    // Create MessageChannel to bridge Worklet ↔ Worker
    const channel = new MessageChannel();

    // Send one port to Worker
    this.worker!.postMessage(
      { type: 'SET_PORT', port: channel.port1 },
      [channel.port1]
    );

    // Send other port to Worklet
    node.port.postMessage(
      { type: WorkletMessageTypes.SET_WORKER_PORT, port: channel.port2 },
      [channel.port2]
    );

    // Tell Worklet the frame length so it can set up buffers
    node.port.postMessage({
      type: WorkletMessageTypes.SET_FRAME_LENGTH,
      value: frameLength,
    });

    // Wait for Worklet to confirm it's ready
    await this.waitForReady();

    return node;
  }

  /**
   * Wait for the worklet to post a READY message.
   */
  waitForReady(): Promise<void> {
    if (!this.workletNode) {
      return Promise.reject(new Error('No worklet node'));
    }

    return new Promise<void>((resolve, reject) => {
      const node = this.workletNode!;
      const prevHandler = node.port.onmessage;
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'READY') {
          node.port.onmessage = prevHandler;
          resolve();
        } else if (event.data?.type === 'ERROR') {
          node.port.onmessage = prevHandler;
          reject(new Error(event.data.error || 'Worklet init failed'));
        } else if (prevHandler) {
          prevHandler.call(node.port, event);
        }
      };
    });
  }

  setSuppressionLevel(level: number): void {
    const clamped = Math.max(0, Math.min(100, Math.floor(level)));
    // Send to Worker (which owns the WASM state)
    if (this.worker) {
      this.worker.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: clamped });
    }
  }

  setNoiseSuppressionEnabled(enabled: boolean): void {
    this.bypassEnabled = !enabled;
    // Send to Worklet (which controls bypass/passthrough)
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: WorkletMessageTypes.SET_BYPASS,
        value: !enabled,
      });
    }
  }

  setAdaptiveEnabled(enabled: boolean): void {
    // Send to Worker (which runs the adaptive logic)
    if (this.worker) {
      this.worker.postMessage({ type: 'SET_ADAPTIVE', value: enabled });
    }
  }

  isNoiseSuppressionEnabled(): boolean {
    return !this.bypassEnabled;
  }

  isReady(): boolean {
    return this.isInitialized && this.workletNode !== null && this.worker !== null;
  }

  get hasWorker(): boolean {
    return this.worker !== null;
  }

  get hasWorkletNode(): boolean {
    return this.workletNode !== null;
  }

  destroy(): void {
    if (!this.isInitialized) return;

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.assets = null;
    this.isInitialized = false;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Processor not initialized. Call initialize() first.');
    }
  }
}
