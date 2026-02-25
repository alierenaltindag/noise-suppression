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
    private isInitialized;
    private bypassEnabled;
    private config;
    constructor(config?: DeepFilterNet3ProcessorConfig);
    initialize(): Promise<void>;
    createAudioWorkletNode(audioContext: AudioContext): Promise<AudioWorkletNode>;
    setSuppressionLevel(level: number): void;
    destroy(): void;
    isReady(): boolean;
    setNoiseSuppressionEnabled(enabled: boolean): void;
    isNoiseSuppressionEnabled(): boolean;
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
    constructor(options?: DeepFilterNoiseFilterOptions);
    static isSupported(): boolean;
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
    suspend: () => Promise<void>;
    resume: () => Promise<void>;
    destroy: () => Promise<void>;
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
