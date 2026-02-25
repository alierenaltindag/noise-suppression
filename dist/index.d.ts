import { TrackProcessor, Track, AudioProcessorOptions } from 'livekit-client';

interface AssetConfig {
    cdnUrl?: string;
    version?: string;
}
interface AssetUrls {
    wasm: string;
    model: string;
}

interface DeepFilterNet3ProcessorConfig {
    sampleRate?: number;
    noiseReductionLevel?: number;
    assetConfig?: AssetConfig;
}
interface DeepFilterNoiseFilterOptions {
    sampleRate?: number;
    frameSize?: number;
    enableNoiseReduction?: boolean;
    noiseReductionLevel?: number;
    assetConfig?: AssetConfig;
    enabled?: boolean;
    /** Supply an existing AudioContext to avoid creating a new one (prevents audio disruption on Windows) */
    audioContext?: AudioContext;
}

declare class DeepFilterNet3Core {
    private assetLoader;
    private assets;
    private workletNode;
    private worker;
    private isInitialized;
    private bypassEnabled;
    private config;
    constructor(config?: DeepFilterNet3ProcessorConfig);
    initialize(): Promise<void>;
    /**
     * Start the processing Worker and initialize WASM inside it.
     * This runs df_create() on a separate thread — NOT the audio render thread.
     * Returns a promise that resolves with the frameLength when WASM is ready.
     */
    private startWorker;
    createAudioWorkletNode(audioContext: AudioContext): Promise<AudioWorkletNode>;
    /**
     * Full warmup: download assets, start Worker (WASM init), register worklet,
     * create node, bridge Worker↔Worklet via MessageChannel.
     *
     * After this resolves, the system is fully ready:
     * - Worker has WASM initialized (df_create done)
     * - Worklet is registered and connected to Worker
     * - Audio render thread was NEVER blocked by WASM
     */
    warmup(audioContext: AudioContext): Promise<AudioWorkletNode>;
    /**
     * Wait for the worklet to post a READY message.
     */
    waitForReady(): Promise<void>;
    setSuppressionLevel(level: number): void;
    setNoiseSuppressionEnabled(enabled: boolean): void;
    setAdaptiveEnabled(enabled: boolean): void;
    isNoiseSuppressionEnabled(): boolean;
    isReady(): boolean;
    get hasWorker(): boolean;
    get hasWorkletNode(): boolean;
    destroy(): void;
    private ensureInitialized;
}

declare class DeepFilterNoiseFilterProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
    name: string;
    processedTrack?: MediaStreamTrack;
    audioContext: AudioContext | null;
    sourceNode: MediaStreamAudioSourceNode | null;
    workletNode: AudioWorkletNode | null;
    destination: MediaStreamAudioDestinationNode | null;
    processor: DeepFilterNet3Core;
    enabled: boolean;
    originalTrack?: MediaStreamTrack;
    private externalAudioContext;
    private ownsAudioContext;
    private sampleRate;
    private _isWarmedUp;
    constructor(options?: DeepFilterNoiseFilterOptions);
    static isSupported(): boolean;
    /**
     * Preload / warmup: downloads WASM + model, registers worklet, creates node,
     * waits for READY message from worklet. After this, the processor is fully
     * initialized with bypass=true. Connecting a track is then instant.
     * Safe to call multiple times — only runs once.
     */
    preload(): Promise<void>;
    init: (opts: {
        track?: MediaStreamTrack;
        mediaStreamTrack?: MediaStreamTrack;
    }) => Promise<void>;
    restart: (opts: {
        track?: MediaStreamTrack;
        mediaStreamTrack?: MediaStreamTrack;
    }) => Promise<void>;
    setEnabled: (enable: boolean) => Promise<boolean>;
    setSuppressionLevel(level: number): void;
    isEnabled(): boolean;
    isNoiseSuppressionEnabled(): boolean;
    get workerRunning(): boolean;
    setAdaptiveEnabled(enabled: boolean): void;
    suspend: () => Promise<void>;
    resume: () => Promise<void>;
    destroy: () => Promise<void>;
    /**
     * Connect (or reconnect) a source track to the already-initialized graph.
     * This is the fast path — no WASM, no worklet registration, just a source node swap.
     */
    private connectSourceTrack;
    private ensureAudioContext;
    /**
     * Full cold-start graph setup (fallback when preload() wasn't called).
     */
    private ensureGraph;
    private teardownGraph;
}
declare function DeepFilterNoiseFilter(options?: DeepFilterNoiseFilterOptions): DeepFilterNoiseFilterProcessor;

declare class AssetLoader {
    private readonly cdnUrl;
    constructor(config?: AssetConfig);
    private getCdnUrl;
    getAssetUrls(): AssetUrls;
    fetchAsset(url: string): Promise<ArrayBuffer>;
}
declare function getAssetLoader(config?: AssetConfig): AssetLoader;

export { AssetLoader, DeepFilterNet3Core, DeepFilterNoiseFilter, DeepFilterNoiseFilterProcessor, getAssetLoader };
export type { AssetConfig, DeepFilterNet3ProcessorConfig, DeepFilterNoiseFilterOptions };
