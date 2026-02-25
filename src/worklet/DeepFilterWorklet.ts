import * as wasm_bindgen from '../df3/df';
import { WorkletMessageTypes } from '../constants';
import type { ProcessorOptions, DeepFilterModel } from '../interfaces';

class DeepFilterAudioProcessor extends AudioWorkletProcessor {
  private dfModel: DeepFilterModel | null = null;
  private inputBuffer: Float32Array;
  private outputBuffer: Float32Array;
  private inputWritePos = 0;
  private inputReadPos = 0;
  private outputWritePos = 0;
  private outputReadPos = 0;
  private bypass = true; // Start bypassed — passthrough until WASM is ready
  private isInitialized = false;
  private bufferSize: number;
  private tempFrame: Float32Array | null = null;

  // Stored options for lazy init
  private pendingOptions: ProcessorOptions | null = null;

  // Adaptive suppression state
  private adaptiveEnabled = false;
  private baseSuppression = 50;
  private minSuppression = 10;
  private currentSuppression = 50;
  private rmsSmoothed = 0;
  private noiseFloor = 0.001;
  private noiseFloorAlpha = 0.001;
  private quietThreshold = 0.005;
  private loudThreshold = 0.03;

  constructor(options: AudioWorkletNodeOptions & { processorOptions: ProcessorOptions }) {
    super();

    this.bufferSize = 8192;
    this.inputBuffer = new Float32Array(this.bufferSize);
    this.outputBuffer = new Float32Array(this.bufferSize);

    // Store options for lazy init — do NOT init WASM here.
    // Constructor runs synchronously on the audio render thread and blocks
    // the main thread (new AudioWorkletNode() waits for it). Heavy WASM
    // init here causes WASAPI buffer underruns on Windows, disrupting
    // audio in other applications. Instead, WASM init is triggered via
    // an INIT message after the node is created.
    this.pendingOptions = options.processorOptions;
    this.baseSuppression = options.processorOptions.suppressionLevel ?? 50;
    this.currentSuppression = this.baseSuppression;

    // Listen for messages immediately (SET_BYPASS, INIT, etc.)
    this.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
  }

  /**
   * Lazy WASM initialization — triggered by INIT message from main thread.
   * Runs on the audio thread but does NOT block the main thread or
   * AudioWorkletNode constructor. process() continues in bypass/passthrough
   * mode while this runs, so no buffer underruns occur.
   */
  private initWasm(): void {
    if (this.isInitialized || !this.pendingOptions) return;

    try {
      wasm_bindgen.initSync(this.pendingOptions.wasmModule);

      const modelBytes = new Uint8Array(this.pendingOptions.modelBytes);
      const handle = wasm_bindgen.df_create(
        modelBytes,
        this.pendingOptions.suppressionLevel ?? 50
      );

      const frameLength = wasm_bindgen.df_get_frame_length(handle);

      this.dfModel = { handle, frameLength };

      this.bufferSize = frameLength * 4;
      this.inputBuffer = new Float32Array(this.bufferSize);
      this.outputBuffer = new Float32Array(this.bufferSize);

      // Pre-allocate temp frame buffer
      this.tempFrame = new Float32Array(frameLength);

      // Pre-fill output ring buffer with silence (one frameLength worth)
      this.outputWritePos = frameLength;

      this.isInitialized = true;
      this.pendingOptions = null;

      // Notify main thread that WASM init is complete
      this.port.postMessage({ type: 'READY' });
    } catch (error) {
      console.error('Failed to initialize DeepFilter in AudioWorklet:', error);
      this.isInitialized = false;
      this.pendingOptions = null;
      this.port.postMessage({ type: 'ERROR', error: String(error) });
    }
  }

  private handleMessage(data: { type: string; value?: number | boolean }): void {
    switch (data.type) {
      case WorkletMessageTypes.INIT:
        // Trigger lazy WASM initialization
        this.initWasm();
        break;
      case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:
        if (this.dfModel && typeof data.value === 'number') {
          const level = Math.max(0, Math.min(100, Math.floor(data.value)));
          this.baseSuppression = level;
          if (!this.adaptiveEnabled) {
            this.currentSuppression = level;
            wasm_bindgen.df_set_atten_lim(this.dfModel.handle, level);
          }
        }
        break;
      case WorkletMessageTypes.SET_BYPASS:
        this.bypass = Boolean(data.value);
        break;
      case WorkletMessageTypes.SET_ADAPTIVE:
        this.adaptiveEnabled = Boolean(data.value);
        if (!this.adaptiveEnabled && this.dfModel) {
          this.currentSuppression = this.baseSuppression;
          wasm_bindgen.df_set_atten_lim(this.dfModel.handle, this.baseSuppression);
        }
        break;
    }
  }

  private computeRMS(buf: Float32Array, len: number): number {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += buf[i] * buf[i];
    }
    return Math.sqrt(sum / len);
  }

  private adaptSuppression(rms: number): void {
    if (!this.dfModel) return;

    if (rms < this.noiseFloor * 3) {
      this.noiseFloor = this.noiseFloor * (1 - this.noiseFloorAlpha) + rms * this.noiseFloorAlpha;
    }

    const alpha = 0.05;
    this.rmsSmoothed = this.rmsSmoothed * (1 - alpha) + rms * alpha;

    let targetSuppression: number;
    if (this.rmsSmoothed <= this.quietThreshold) {
      targetSuppression = this.minSuppression;
    } else if (this.rmsSmoothed >= this.loudThreshold) {
      targetSuppression = this.baseSuppression;
    } else {
      const t = (this.rmsSmoothed - this.quietThreshold) / (this.loudThreshold - this.quietThreshold);
      targetSuppression = this.minSuppression + t * (this.baseSuppression - this.minSuppression);
    }

    const rounded = Math.floor(targetSuppression);
    if (Math.abs(rounded - this.currentSuppression) >= 2) {
      this.currentSuppression = rounded;
      wasm_bindgen.df_set_atten_lim(this.dfModel.handle, rounded);
    }
  }

  private getInputAvailable(): number {
    return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;
  }

  private getOutputAvailable(): number {
    return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;
  }

  process(inputList: Float32Array[][], outputList: Float32Array[][]): boolean {
    const sourceLimit = Math.min(inputList.length, outputList.length);

    const input = inputList[0]?.[0];
    if (!input) {
      return true;
    }

    // Passthrough mode - copy input to all output channels
    if (!this.isInitialized || !this.dfModel || this.bypass || !this.tempFrame) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        const channelCount = output.length;
        for (let channelNum = 0; channelNum < channelCount; channelNum++) {
          output[channelNum].set(input);
        }
      }
      return true;
    }

    // Write input to ring buffer
    for (let i = 0; i < input.length; i++) {
      this.inputBuffer[this.inputWritePos] = input[i];
      this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
    }

    const frameLength = this.dfModel.frameLength;

    while (this.getInputAvailable() >= frameLength) {
      for (let i = 0; i < frameLength; i++) {
        this.tempFrame[i] = this.inputBuffer[this.inputReadPos];
        this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
      }

      if (this.adaptiveEnabled) {
        const rms = this.computeRMS(this.tempFrame, frameLength);
        this.adaptSuppression(rms);
      }

      const processed = wasm_bindgen.df_process_frame(this.dfModel.handle, this.tempFrame);

      for (let i = 0; i < processed.length; i++) {
        this.outputBuffer[this.outputWritePos] = processed[i];
        this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
      }
    }

    const outputAvailable = this.getOutputAvailable();
    if (outputAvailable >= 128) {
      for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
        const output = outputList[inputNum];
        const channelCount = output.length;

        for (let channelNum = 0; channelNum < channelCount; channelNum++) {
          const outputChannel = output[channelNum];
          let readPos = this.outputReadPos;

          for (let i = 0; i < 128; i++) {
            outputChannel[i] = this.outputBuffer[readPos];
            readPos = (readPos + 1) % this.bufferSize;
          }
        }
      }
      this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;
    }
    return true;
  }
}

registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);
