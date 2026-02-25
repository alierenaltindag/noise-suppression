class AssetLoader {
    constructor(config = {}) {
        this.cdnUrl = config.cdnUrl ?? 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3';
    }
    getCdnUrl(relativePath) {
        return `${this.cdnUrl}/${relativePath}`;
    }
    getAssetUrls() {
        return {
            wasm: this.getCdnUrl('v2/pkg/df_bg.wasm'),
            model: this.getCdnUrl('v2/models/DeepFilterNet3_onnx.tar.gz')
        };
    }
    async fetchAsset(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch asset: ${response.statusText}`);
        }
        return response.arrayBuffer();
    }
}
let defaultLoader = null;
function getAssetLoader(config) {
    if (!defaultLoader || config) {
        defaultLoader = new AssetLoader(config);
    }
    return defaultLoader;
}

/**
 * Creates a worklet module URL from inline code string
 * This approach works with all bundlers without special configuration
 */
async function createWorkletModule(audioContext, workletCode) {
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await audioContext.audioWorklet.addModule(blobUrl);
}

const WorkletMessageTypes = {
    INIT: 'INIT',
    SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',
    SET_BYPASS: 'SET_BYPASS',
    SET_ADAPTIVE: 'SET_ADAPTIVE',
};

var workletCode = "(function () {\n    'use strict';\n\n    let wasm;\r\n\r\n    const heap = new Array(128).fill(undefined);\r\n\r\n    heap.push(undefined, null, true, false);\r\n\r\n    function getObject(idx) { return heap[idx]; }\r\n\r\n    let heap_next = heap.length;\r\n\r\n    function dropObject(idx) {\r\n        if (idx < 132) return;\r\n        heap[idx] = heap_next;\r\n        heap_next = idx;\r\n    }\r\n\r\n    function takeObject(idx) {\r\n        const ret = getObject(idx);\r\n        dropObject(idx);\r\n        return ret;\r\n    }\r\n\r\n    const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );\r\n\r\n    if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); }\r\n    let cachedUint8Memory0 = null;\r\n\r\n    function getUint8Memory0() {\r\n        if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {\r\n            cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);\r\n        }\r\n        return cachedUint8Memory0;\r\n    }\r\n\r\n    function getStringFromWasm0(ptr, len) {\r\n        ptr = ptr >>> 0;\r\n        return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));\r\n    }\r\n\r\n    function addHeapObject(obj) {\r\n        if (heap_next === heap.length) heap.push(heap.length + 1);\r\n        const idx = heap_next;\r\n        heap_next = heap[idx];\r\n\r\n        heap[idx] = obj;\r\n        return idx;\r\n    }\r\n    /**\r\n    * Set DeepFilterNet attenuation limit.\r\n    *\r\n    * Args:\r\n    *     - lim_db: New attenuation limit in dB.\r\n    * @param {number} st\r\n    * @param {number} lim_db\r\n    */\r\n    function df_set_atten_lim(st, lim_db) {\r\n        wasm.df_set_atten_lim(st, lim_db);\r\n    }\r\n\r\n    /**\r\n    * Get DeepFilterNet frame size in samples.\r\n    * @param {number} st\r\n    * @returns {number}\r\n    */\r\n    function df_get_frame_length(st) {\r\n        const ret = wasm.df_get_frame_length(st);\r\n        return ret >>> 0;\r\n    }\r\n\r\n    let WASM_VECTOR_LEN = 0;\r\n\r\n    function passArray8ToWasm0(arg, malloc) {\r\n        const ptr = malloc(arg.length * 1, 1) >>> 0;\r\n        getUint8Memory0().set(arg, ptr / 1);\r\n        WASM_VECTOR_LEN = arg.length;\r\n        return ptr;\r\n    }\r\n    /**\r\n    * Create a DeepFilterNet Model\r\n    *\r\n    * Args:\r\n    *     - path: File path to a DeepFilterNet tar.gz onnx model\r\n    *     - atten_lim: Attenuation limit in dB.\r\n    *\r\n    * Returns:\r\n    *     - DF state doing the full processing: stft, DNN noise reduction, istft.\r\n    * @param {Uint8Array} model_bytes\r\n    * @param {number} atten_lim\r\n    * @returns {number}\r\n    */\r\n    function df_create(model_bytes, atten_lim) {\r\n        const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc);\r\n        const len0 = WASM_VECTOR_LEN;\r\n        const ret = wasm.df_create(ptr0, len0, atten_lim);\r\n        return ret >>> 0;\r\n    }\r\n\r\n    let cachedFloat32Memory0 = null;\r\n\r\n    function getFloat32Memory0() {\r\n        if (cachedFloat32Memory0 === null || cachedFloat32Memory0.byteLength === 0) {\r\n            cachedFloat32Memory0 = new Float32Array(wasm.memory.buffer);\r\n        }\r\n        return cachedFloat32Memory0;\r\n    }\r\n\r\n    function passArrayF32ToWasm0(arg, malloc) {\r\n        const ptr = malloc(arg.length * 4, 4) >>> 0;\r\n        getFloat32Memory0().set(arg, ptr / 4);\r\n        WASM_VECTOR_LEN = arg.length;\r\n        return ptr;\r\n    }\r\n    /**\r\n    * Processes a chunk of samples.\r\n    *\r\n    * Args:\r\n    *     - df_state: Created via df_create()\r\n    *     - input: Input buffer of length df_get_frame_length()\r\n    *     - output: Output buffer of length df_get_frame_length()\r\n    *\r\n    * Returns:\r\n    *     - Local SNR of the current frame.\r\n    * @param {number} st\r\n    * @param {Float32Array} input\r\n    * @returns {Float32Array}\r\n    */\r\n    function df_process_frame(st, input) {\r\n        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);\r\n        const len0 = WASM_VECTOR_LEN;\r\n        const ret = wasm.df_process_frame(st, ptr0, len0);\r\n        return takeObject(ret);\r\n    }\r\n\r\n    function handleError(f, args) {\r\n        try {\r\n            return f.apply(this, args);\r\n        } catch (e) {\r\n            wasm.__wbindgen_exn_store(addHeapObject(e));\r\n        }\r\n    }\r\n\r\n    (typeof FinalizationRegistry === 'undefined')\r\n        ? { }\r\n        : new FinalizationRegistry(ptr => wasm.__wbg_dfstate_free(ptr >>> 0));\r\n\r\n    function __wbg_get_imports() {\r\n        const imports = {};\r\n        imports.wbg = {};\r\n        imports.wbg.__wbindgen_object_drop_ref = function(arg0) {\r\n            takeObject(arg0);\r\n        };\r\n        imports.wbg.__wbg_crypto_566d7465cdbb6b7a = function(arg0) {\r\n            const ret = getObject(arg0).crypto;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbindgen_is_object = function(arg0) {\r\n            const val = getObject(arg0);\r\n            const ret = typeof(val) === 'object' && val !== null;\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbg_process_dc09a8c7d59982f6 = function(arg0) {\r\n            const ret = getObject(arg0).process;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_versions_d98c6400c6ca2bd8 = function(arg0) {\r\n            const ret = getObject(arg0).versions;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_node_caaf83d002149bd5 = function(arg0) {\r\n            const ret = getObject(arg0).node;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbindgen_is_string = function(arg0) {\r\n            const ret = typeof(getObject(arg0)) === 'string';\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbg_require_94a9da52636aacbf = function() { return handleError(function () {\r\n            const ret = module.require;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_is_function = function(arg0) {\r\n            const ret = typeof(getObject(arg0)) === 'function';\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbindgen_string_new = function(arg0, arg1) {\r\n            const ret = getStringFromWasm0(arg0, arg1);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_msCrypto_0b84745e9245cdf6 = function(arg0) {\r\n            const ret = getObject(arg0).msCrypto;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_randomFillSync_290977693942bf03 = function() { return handleError(function (arg0, arg1) {\r\n            getObject(arg0).randomFillSync(takeObject(arg1));\r\n        }, arguments) };\r\n        imports.wbg.__wbg_getRandomValues_260cc23a41afad9a = function() { return handleError(function (arg0, arg1) {\r\n            getObject(arg0).getRandomValues(getObject(arg1));\r\n        }, arguments) };\r\n        imports.wbg.__wbg_newnoargs_e258087cd0daa0ea = function(arg0, arg1) {\r\n            const ret = new Function(getStringFromWasm0(arg0, arg1));\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_new_63b92bc8671ed464 = function(arg0) {\r\n            const ret = new Uint8Array(getObject(arg0));\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_new_9efabd6b6d2ce46d = function(arg0) {\r\n            const ret = new Float32Array(getObject(arg0));\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_buffer_12d079cc21e14bdb = function(arg0) {\r\n            const ret = getObject(arg0).buffer;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb = function(arg0, arg1, arg2) {\r\n            const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_newwithlength_e9b4878cebadb3d3 = function(arg0) {\r\n            const ret = new Uint8Array(arg0 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_set_a47bac70306a19a7 = function(arg0, arg1, arg2) {\r\n            getObject(arg0).set(getObject(arg1), arg2 >>> 0);\r\n        };\r\n        imports.wbg.__wbg_subarray_a1f73cd4b5b42fe1 = function(arg0, arg1, arg2) {\r\n            const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_newwithbyteoffsetandlength_4a659d079a1650e0 = function(arg0, arg1, arg2) {\r\n            const ret = new Float32Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_self_ce0dbfc45cf2f5be = function() { return handleError(function () {\r\n            const ret = self.self;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbg_window_c6fb939a7f436783 = function() { return handleError(function () {\r\n            const ret = window.window;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbg_globalThis_d1e6af4856ba331b = function() { return handleError(function () {\r\n            const ret = globalThis.globalThis;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbg_global_207b558942527489 = function() { return handleError(function () {\r\n            const ret = global.global;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_is_undefined = function(arg0) {\r\n            const ret = getObject(arg0) === undefined;\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbg_call_27c0f87801dedf93 = function() { return handleError(function (arg0, arg1) {\r\n            const ret = getObject(arg0).call(getObject(arg1));\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_object_clone_ref = function(arg0) {\r\n            const ret = getObject(arg0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_call_b3ca7c6051f9bec1 = function() { return handleError(function (arg0, arg1, arg2) {\r\n            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_memory = function() {\r\n            const ret = wasm.memory;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbindgen_throw = function(arg0, arg1) {\r\n            throw new Error(getStringFromWasm0(arg0, arg1));\r\n        };\r\n\r\n        return imports;\r\n    }\r\n\r\n    function __wbg_finalize_init(instance, module) {\r\n        wasm = instance.exports;\r\n        cachedFloat32Memory0 = null;\r\n        cachedUint8Memory0 = null;\r\n\r\n\r\n        return wasm;\r\n    }\r\n\r\n    function initSync(module) {\r\n        if (wasm !== undefined) return wasm;\r\n\r\n        const imports = __wbg_get_imports();\r\n\r\n        if (!(module instanceof WebAssembly.Module)) {\r\n            module = new WebAssembly.Module(module);\r\n        }\r\n\r\n        const instance = new WebAssembly.Instance(module, imports);\r\n\r\n        return __wbg_finalize_init(instance);\r\n    }\n\n    const WorkletMessageTypes = {\n        INIT: 'INIT',\n        SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',\n        SET_BYPASS: 'SET_BYPASS',\n        SET_ADAPTIVE: 'SET_ADAPTIVE',\n    };\n\n    class DeepFilterAudioProcessor extends AudioWorkletProcessor {\n        constructor(options) {\n            super();\n            this.dfModel = null;\n            this.inputWritePos = 0;\n            this.inputReadPos = 0;\n            this.outputWritePos = 0;\n            this.outputReadPos = 0;\n            this.bypass = true; // Start bypassed — passthrough until WASM is ready\n            this.isInitialized = false;\n            this.tempFrame = null;\n            // Stored options for lazy init\n            this.pendingOptions = null;\n            // Adaptive suppression state\n            this.adaptiveEnabled = false;\n            this.baseSuppression = 50;\n            this.minSuppression = 10;\n            this.currentSuppression = 50;\n            this.rmsSmoothed = 0;\n            this.noiseFloor = 0.001;\n            this.noiseFloorAlpha = 0.001;\n            this.quietThreshold = 0.005;\n            this.loudThreshold = 0.03;\n            this.bufferSize = 8192;\n            this.inputBuffer = new Float32Array(this.bufferSize);\n            this.outputBuffer = new Float32Array(this.bufferSize);\n            // Store options for lazy init — do NOT init WASM here.\n            // Constructor runs synchronously on the audio render thread and blocks\n            // the main thread (new AudioWorkletNode() waits for it). Heavy WASM\n            // init here causes WASAPI buffer underruns on Windows, disrupting\n            // audio in other applications. Instead, WASM init is triggered via\n            // an INIT message after the node is created.\n            this.pendingOptions = options.processorOptions;\n            this.baseSuppression = options.processorOptions.suppressionLevel ?? 50;\n            this.currentSuppression = this.baseSuppression;\n            // Listen for messages immediately (SET_BYPASS, INIT, etc.)\n            this.port.onmessage = (event) => {\n                this.handleMessage(event.data);\n            };\n        }\n        /**\n         * Lazy WASM initialization — triggered by INIT message from main thread.\n         * Runs on the audio thread but does NOT block the main thread or\n         * AudioWorkletNode constructor. process() continues in bypass/passthrough\n         * mode while this runs, so no buffer underruns occur.\n         */\n        initWasm() {\n            if (this.isInitialized || !this.pendingOptions)\n                return;\n            try {\n                initSync(this.pendingOptions.wasmModule);\n                const modelBytes = new Uint8Array(this.pendingOptions.modelBytes);\n                const handle = df_create(modelBytes, this.pendingOptions.suppressionLevel ?? 50);\n                const frameLength = df_get_frame_length(handle);\n                this.dfModel = { handle, frameLength };\n                this.bufferSize = frameLength * 4;\n                this.inputBuffer = new Float32Array(this.bufferSize);\n                this.outputBuffer = new Float32Array(this.bufferSize);\n                // Pre-allocate temp frame buffer\n                this.tempFrame = new Float32Array(frameLength);\n                // Pre-fill output ring buffer with silence (one frameLength worth)\n                this.outputWritePos = frameLength;\n                this.isInitialized = true;\n                this.pendingOptions = null;\n                // Notify main thread that WASM init is complete\n                this.port.postMessage({ type: 'READY' });\n            }\n            catch (error) {\n                console.error('Failed to initialize DeepFilter in AudioWorklet:', error);\n                this.isInitialized = false;\n                this.pendingOptions = null;\n                this.port.postMessage({ type: 'ERROR', error: String(error) });\n            }\n        }\n        handleMessage(data) {\n            switch (data.type) {\n                case WorkletMessageTypes.INIT:\n                    // Trigger lazy WASM initialization\n                    this.initWasm();\n                    break;\n                case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:\n                    if (this.dfModel && typeof data.value === 'number') {\n                        const level = Math.max(0, Math.min(100, Math.floor(data.value)));\n                        this.baseSuppression = level;\n                        if (!this.adaptiveEnabled) {\n                            this.currentSuppression = level;\n                            df_set_atten_lim(this.dfModel.handle, level);\n                        }\n                    }\n                    break;\n                case WorkletMessageTypes.SET_BYPASS:\n                    this.bypass = Boolean(data.value);\n                    break;\n                case WorkletMessageTypes.SET_ADAPTIVE:\n                    this.adaptiveEnabled = Boolean(data.value);\n                    if (!this.adaptiveEnabled && this.dfModel) {\n                        this.currentSuppression = this.baseSuppression;\n                        df_set_atten_lim(this.dfModel.handle, this.baseSuppression);\n                    }\n                    break;\n            }\n        }\n        computeRMS(buf, len) {\n            let sum = 0;\n            for (let i = 0; i < len; i++) {\n                sum += buf[i] * buf[i];\n            }\n            return Math.sqrt(sum / len);\n        }\n        adaptSuppression(rms) {\n            if (!this.dfModel)\n                return;\n            if (rms < this.noiseFloor * 3) {\n                this.noiseFloor = this.noiseFloor * (1 - this.noiseFloorAlpha) + rms * this.noiseFloorAlpha;\n            }\n            const alpha = 0.05;\n            this.rmsSmoothed = this.rmsSmoothed * (1 - alpha) + rms * alpha;\n            let targetSuppression;\n            if (this.rmsSmoothed <= this.quietThreshold) {\n                targetSuppression = this.minSuppression;\n            }\n            else if (this.rmsSmoothed >= this.loudThreshold) {\n                targetSuppression = this.baseSuppression;\n            }\n            else {\n                const t = (this.rmsSmoothed - this.quietThreshold) / (this.loudThreshold - this.quietThreshold);\n                targetSuppression = this.minSuppression + t * (this.baseSuppression - this.minSuppression);\n            }\n            const rounded = Math.floor(targetSuppression);\n            if (Math.abs(rounded - this.currentSuppression) >= 2) {\n                this.currentSuppression = rounded;\n                df_set_atten_lim(this.dfModel.handle, rounded);\n            }\n        }\n        getInputAvailable() {\n            return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;\n        }\n        getOutputAvailable() {\n            return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;\n        }\n        process(inputList, outputList) {\n            const sourceLimit = Math.min(inputList.length, outputList.length);\n            const input = inputList[0]?.[0];\n            if (!input) {\n                return true;\n            }\n            // Passthrough mode - copy input to all output channels\n            if (!this.isInitialized || !this.dfModel || this.bypass || !this.tempFrame) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    const channelCount = output.length;\n                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {\n                        output[channelNum].set(input);\n                    }\n                }\n                return true;\n            }\n            // Write input to ring buffer\n            for (let i = 0; i < input.length; i++) {\n                this.inputBuffer[this.inputWritePos] = input[i];\n                this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;\n            }\n            const frameLength = this.dfModel.frameLength;\n            while (this.getInputAvailable() >= frameLength) {\n                for (let i = 0; i < frameLength; i++) {\n                    this.tempFrame[i] = this.inputBuffer[this.inputReadPos];\n                    this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;\n                }\n                if (this.adaptiveEnabled) {\n                    const rms = this.computeRMS(this.tempFrame, frameLength);\n                    this.adaptSuppression(rms);\n                }\n                const processed = df_process_frame(this.dfModel.handle, this.tempFrame);\n                for (let i = 0; i < processed.length; i++) {\n                    this.outputBuffer[this.outputWritePos] = processed[i];\n                    this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;\n                }\n            }\n            const outputAvailable = this.getOutputAvailable();\n            if (outputAvailable >= 128) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    const channelCount = output.length;\n                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {\n                        const outputChannel = output[channelNum];\n                        let readPos = this.outputReadPos;\n                        for (let i = 0; i < 128; i++) {\n                            outputChannel[i] = this.outputBuffer[readPos];\n                            readPos = (readPos + 1) % this.bufferSize;\n                        }\n                    }\n                }\n                this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;\n            }\n            return true;\n        }\n    }\n    registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);\n\n})();\n";

class DeepFilterNet3Core {
    constructor(config = {}) {
        this.assets = null;
        this.workletNode = null;
        this.isInitialized = false;
        this.bypassEnabled = false;
        this.config = {
            sampleRate: config.sampleRate ?? 48000,
            noiseReductionLevel: config.noiseReductionLevel ?? 50,
            assetConfig: config.assetConfig
        };
        this.assetLoader = getAssetLoader(config.assetConfig);
    }
    async initialize() {
        if (this.isInitialized)
            return;
        // Fetch and compile WASM on main thread
        const assetUrls = this.assetLoader.getAssetUrls();
        const [wasmBytes, modelBytes] = await Promise.all([
            this.assetLoader.fetchAsset(assetUrls.wasm),
            this.assetLoader.fetchAsset(assetUrls.model)
        ]);
        // Compile WASM module
        const wasmModule = await WebAssembly.compile(wasmBytes);
        this.assets = { wasmModule, modelBytes };
        this.isInitialized = true;
    }
    async createAudioWorkletNode(audioContext) {
        this.ensureInitialized();
        if (!this.assets) {
            throw new Error('Assets not loaded');
        }
        await createWorkletModule(audioContext, workletCode);
        // Create node with lazy init — constructor does NOT init WASM.
        // This makes `new AudioWorkletNode()` return instantly without
        // blocking the audio render thread (no WASAPI buffer underruns).
        this.workletNode = new AudioWorkletNode(audioContext, 'deepfilter-audio-processor', {
            processorOptions: {
                wasmModule: this.assets.wasmModule,
                modelBytes: this.assets.modelBytes,
                suppressionLevel: this.config.noiseReductionLevel
            }
        });
        // Trigger WASM init via message — runs on audio thread asynchronously.
        // process() stays in bypass/passthrough mode until init completes.
        this.workletNode.port.postMessage({ type: WorkletMessageTypes.INIT });
        return this.workletNode;
    }
    /**
     * Wait for the worklet to post a READY message, meaning WASM init is done.
     * Call this after createAudioWorkletNode() to ensure the worklet is fully ready.
     */
    waitForReady() {
        if (!this.workletNode) {
            return Promise.reject(new Error('No worklet node — call createAudioWorkletNode first'));
        }
        return new Promise((resolve, reject) => {
            const node = this.workletNode;
            // Save existing onmessage handler if any
            const prevHandler = node.port.onmessage;
            node.port.onmessage = (event) => {
                if (event.data?.type === 'READY') {
                    // Restore previous handler
                    node.port.onmessage = prevHandler;
                    resolve();
                }
                else if (event.data?.type === 'ERROR') {
                    node.port.onmessage = prevHandler;
                    reject(new Error(event.data.error || 'Worklet init failed'));
                }
                else if (prevHandler) {
                    prevHandler.call(node.port, event);
                }
            };
        });
    }
    /**
     * Full warmup: download WASM + model, register worklet, create node, wait for READY.
     * After this resolves, the processor is fully initialized and bypass=true.
     * Connecting a track afterwards is instant (no CPU spike, no audio glitch).
     */
    async warmup(audioContext) {
        await this.initialize();
        const node = await this.createAudioWorkletNode(audioContext);
        await this.waitForReady();
        return node;
    }
    setSuppressionLevel(level) {
        if (!this.workletNode || typeof level !== 'number' || isNaN(level))
            return;
        const clampedLevel = Math.max(0, Math.min(100, Math.floor(level)));
        this.workletNode.port.postMessage({
            type: WorkletMessageTypes.SET_SUPPRESSION_LEVEL,
            value: clampedLevel
        });
    }
    destroy() {
        if (!this.isInitialized)
            return;
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        this.assets = null;
        this.isInitialized = false;
    }
    isReady() {
        return this.isInitialized && this.workletNode !== null;
    }
    setNoiseSuppressionEnabled(enabled) {
        if (!this.workletNode)
            return;
        this.bypassEnabled = !enabled;
        this.workletNode.port.postMessage({
            type: WorkletMessageTypes.SET_BYPASS,
            value: !enabled
        });
    }
    setAdaptiveEnabled(enabled) {
        if (!this.workletNode)
            return;
        this.workletNode.port.postMessage({
            type: WorkletMessageTypes.SET_ADAPTIVE,
            value: enabled
        });
    }
    isNoiseSuppressionEnabled() {
        return !this.bypassEnabled;
    }
    ensureInitialized() {
        if (!this.isInitialized) {
            throw new Error('Processor not initialized. Call initialize() first.');
        }
    }
}

class DeepFilterNoiseFilterProcessor {
    constructor(options = {}) {
        this.name = 'deepfilternet3-noise-filter';
        this.audioContext = null;
        this.sourceNode = null;
        this.workletNode = null;
        this.destination = null;
        this.enabled = true;
        this.externalAudioContext = null;
        this.ownsAudioContext = false;
        this._isWarmedUp = false;
        this.init = async (opts) => {
            const track = opts.track ?? opts.mediaStreamTrack;
            if (!track) {
                throw new Error('DeepFilterNoiseFilterProcessor.init: missing MediaStreamTrack');
            }
            this.originalTrack = track;
            if (this._isWarmedUp) {
                // Fast path: everything is pre-initialized, just connect the source node
                this.connectSourceTrack(track);
                await this.setEnabled(this.enabled);
            }
            else {
                // Fallback: full init (cold start)
                await this.ensureGraph();
            }
        };
        this.restart = async (opts) => {
            const track = opts.track ?? opts.mediaStreamTrack;
            if (track) {
                this.originalTrack = track;
            }
            if (this._isWarmedUp && this.originalTrack) {
                this.connectSourceTrack(this.originalTrack);
                await this.setEnabled(this.enabled);
            }
            else {
                await this.ensureGraph();
            }
        };
        this.setEnabled = async (enable) => {
            this.enabled = enable;
            this.processor.setNoiseSuppressionEnabled(enable);
            return this.enabled;
        };
        this.suspend = async () => {
            if (this.audioContext && this.audioContext.state === 'running') {
                await this.audioContext.suspend();
            }
        };
        this.resume = async () => {
            if (this.audioContext && this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        };
        this.destroy = async () => {
            await this.teardownGraph();
            this.processor.destroy();
            this._isWarmedUp = false;
        };
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
    static isSupported() {
        return typeof AudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
    }
    /**
     * Preload / warmup: downloads WASM + model, registers worklet, creates node,
     * waits for READY message from worklet. After this, the processor is fully
     * initialized with bypass=true. Connecting a track is then instant.
     * Safe to call multiple times — only runs once.
     */
    async preload() {
        if (this._isWarmedUp)
            return;
        this.ensureAudioContext();
        if (this.audioContext.state !== 'running') {
            try {
                await this.audioContext.resume();
            }
            catch { }
        }
        // Full warmup: WASM download + compile + worklet registration + node creation + wait for READY
        this.workletNode = await this.processor.warmup(this.audioContext);
        // Create destination now so processedTrack is ready
        if (!this.destination) {
            this.destination = this.audioContext.createMediaStreamDestination();
            this.processedTrack = this.destination.stream.getAudioTracks()[0];
        }
        this._isWarmedUp = true;
    }
    setSuppressionLevel(level) {
        this.processor.setSuppressionLevel(level);
    }
    isEnabled() {
        return this.enabled;
    }
    isNoiseSuppressionEnabled() {
        return this.processor.isNoiseSuppressionEnabled();
    }
    setAdaptiveEnabled(enabled) {
        this.processor.setAdaptiveEnabled(enabled);
    }
    /**
     * Connect (or reconnect) a source track to the already-initialized graph.
     * This is the fast path — no WASM, no worklet registration, just a source node swap.
     */
    connectSourceTrack(track) {
        if (!this.audioContext || !this.workletNode || !this.destination) {
            throw new Error('Graph not initialized — call preload() first');
        }
        // Disconnect old source if any
        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            }
            catch { }
        }
        this.sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([track]));
        this.sourceNode.connect(this.workletNode).connect(this.destination);
    }
    ensureAudioContext() {
        if (!this.audioContext) {
            if (this.externalAudioContext) {
                this.audioContext = this.externalAudioContext;
                this.ownsAudioContext = false;
            }
            else {
                this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
                this.ownsAudioContext = true;
            }
        }
    }
    /**
     * Full cold-start graph setup (fallback when preload() wasn't called).
     */
    async ensureGraph() {
        if (!this.originalTrack) {
            throw new Error('No source track');
        }
        this.ensureAudioContext();
        if (this.audioContext.state !== 'running') {
            try {
                await this.audioContext.resume();
            }
            catch { }
        }
        await this.processor.initialize();
        if (!this.workletNode) {
            const node = await this.processor.createAudioWorkletNode(this.audioContext);
            this.workletNode = node;
            // Wait for worklet READY even in cold-start path
            await this.processor.waitForReady();
        }
        if (!this.destination) {
            this.destination = this.audioContext.createMediaStreamDestination();
            this.processedTrack = this.destination.stream.getAudioTracks()[0];
        }
        this.connectSourceTrack(this.originalTrack);
        this._isWarmedUp = true;
        await this.setEnabled(this.enabled);
    }
    async teardownGraph() {
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
        }
        catch {
            // Ignore disconnect errors
        }
    }
}
function DeepFilterNoiseFilter(options) {
    return new DeepFilterNoiseFilterProcessor(options);
}

export { AssetLoader, DeepFilterNet3Core, DeepFilterNoiseFilter, DeepFilterNoiseFilterProcessor, getAssetLoader };
