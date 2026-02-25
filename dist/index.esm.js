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
    SET_BYPASS: 'SET_BYPASS',
    SET_WORKER_PORT: 'SET_WORKER_PORT',
    SET_FRAME_LENGTH: 'SET_FRAME_LENGTH',
};

var workletCode = "(function () {\n    'use strict';\n\n    const WorkletMessageTypes = {\n        SET_BYPASS: 'SET_BYPASS',\n        SET_WORKER_PORT: 'SET_WORKER_PORT',\n        SET_FRAME_LENGTH: 'SET_FRAME_LENGTH',\n    };\n\n    /**\n     * DeepFilterWorklet — lightweight I/O bridge for audio processing.\n     *\n     * This worklet does NO WASM processing. It only:\n     * 1. Collects input samples into frames (ring buffer)\n     * 2. Sends complete frames to DeepFilterWorker via MessagePort\n     * 3. Receives processed frames back and writes to output ring buffer\n     * 4. Outputs processed samples from the output ring buffer\n     *\n     * All heavy WASM work (df_create, df_process_frame) runs in the Worker\n     * on a separate thread, keeping the audio render thread unblocked.\n     * This prevents WASAPI buffer underruns that disrupt other apps' audio.\n     */\n    class DeepFilterAudioProcessor extends AudioWorkletProcessor {\n        constructor() {\n            super();\n            this.inputWritePos = 0;\n            this.inputReadPos = 0;\n            this.outputWritePos = 0;\n            this.outputReadPos = 0;\n            this.bypass = true;\n            this.isReady = false;\n            this.frameLength = 480; // Default, updated when Worker sends READY\n            this.tempFrame = null;\n            // MessagePort to communicate with DeepFilterWorker\n            this.workerPort = null;\n            // Track pending frames to avoid flooding the Worker\n            this.pendingFrames = 0;\n            this.maxPendingFrames = 4;\n            this.bufferSize = 8192;\n            this.inputBuffer = new Float32Array(this.bufferSize);\n            this.outputBuffer = new Float32Array(this.bufferSize);\n            this.port.onmessage = (event) => {\n                this.handleMessage(event.data);\n            };\n        }\n        handleMessage(data) {\n            switch (data.type) {\n                case WorkletMessageTypes.SET_WORKER_PORT: {\n                    // Receive MessagePort for direct Worker communication\n                    this.workerPort = data.port;\n                    this.workerPort.onmessage = (e) => {\n                        if (e.data.type === 'PROCESSED') {\n                            this.onProcessedFrame(e.data.samples);\n                        }\n                    };\n                    break;\n                }\n                case WorkletMessageTypes.SET_FRAME_LENGTH: {\n                    // Worker finished init, tells us the frame length\n                    this.frameLength = data.value;\n                    this.bufferSize = this.frameLength * 8;\n                    this.inputBuffer = new Float32Array(this.bufferSize);\n                    this.outputBuffer = new Float32Array(this.bufferSize);\n                    this.tempFrame = new Float32Array(this.frameLength);\n                    // Pre-fill output with silence (one frame worth of latency)\n                    this.outputWritePos = this.frameLength;\n                    this.inputWritePos = 0;\n                    this.inputReadPos = 0;\n                    this.outputReadPos = 0;\n                    this.pendingFrames = 0;\n                    this.isReady = true;\n                    this.port.postMessage({ type: 'READY' });\n                    break;\n                }\n                case WorkletMessageTypes.SET_BYPASS:\n                    this.bypass = Boolean(data.value);\n                    break;\n            }\n        }\n        /**\n         * Called when Worker sends back a processed frame.\n         * Write it into the output ring buffer.\n         */\n        onProcessedFrame(samples) {\n            this.pendingFrames = Math.max(0, this.pendingFrames - 1);\n            for (let i = 0; i < samples.length; i++) {\n                this.outputBuffer[this.outputWritePos] = samples[i];\n                this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;\n            }\n        }\n        getInputAvailable() {\n            return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;\n        }\n        getOutputAvailable() {\n            return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;\n        }\n        process(inputList, outputList) {\n            const sourceLimit = Math.min(inputList.length, outputList.length);\n            const input = inputList[0]?.[0];\n            if (!input)\n                return true;\n            // Passthrough mode\n            if (!this.isReady || this.bypass || !this.workerPort || !this.tempFrame) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    for (let ch = 0; ch < output.length; ch++) {\n                        output[ch].set(input);\n                    }\n                }\n                return true;\n            }\n            // Write input to ring buffer\n            for (let i = 0; i < input.length; i++) {\n                this.inputBuffer[this.inputWritePos] = input[i];\n                this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;\n            }\n            // Send complete frames to Worker for processing\n            while (this.getInputAvailable() >= this.frameLength &&\n                this.pendingFrames < this.maxPendingFrames) {\n                for (let i = 0; i < this.frameLength; i++) {\n                    this.tempFrame[i] = this.inputBuffer[this.inputReadPos];\n                    this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;\n                }\n                // Copy frame data (tempFrame is reused, need a copy for transfer)\n                const frameCopy = new Float32Array(this.tempFrame);\n                this.workerPort.postMessage({ type: 'FRAME', samples: frameCopy }, [frameCopy.buffer] // Transfer — zero-copy send\n                );\n                this.pendingFrames++;\n            }\n            // Read processed output\n            const outputAvailable = this.getOutputAvailable();\n            if (outputAvailable >= 128) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    for (let ch = 0; ch < output.length; ch++) {\n                        const outputChannel = output[ch];\n                        let readPos = this.outputReadPos;\n                        for (let i = 0; i < 128; i++) {\n                            outputChannel[i] = this.outputBuffer[readPos];\n                            readPos = (readPos + 1) % this.bufferSize;\n                        }\n                    }\n                }\n                this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;\n            }\n            return true;\n        }\n    }\n    registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);\n\n})();\n";

var workerCode = "(function () {\n    'use strict';\n\n    let wasm;\r\n\r\n    const heap = new Array(128).fill(undefined);\r\n\r\n    heap.push(undefined, null, true, false);\r\n\r\n    function getObject(idx) { return heap[idx]; }\r\n\r\n    let heap_next = heap.length;\r\n\r\n    function dropObject(idx) {\r\n        if (idx < 132) return;\r\n        heap[idx] = heap_next;\r\n        heap_next = idx;\r\n    }\r\n\r\n    function takeObject(idx) {\r\n        const ret = getObject(idx);\r\n        dropObject(idx);\r\n        return ret;\r\n    }\r\n\r\n    const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );\r\n\r\n    if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); }\r\n    let cachedUint8Memory0 = null;\r\n\r\n    function getUint8Memory0() {\r\n        if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {\r\n            cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);\r\n        }\r\n        return cachedUint8Memory0;\r\n    }\r\n\r\n    function getStringFromWasm0(ptr, len) {\r\n        ptr = ptr >>> 0;\r\n        return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));\r\n    }\r\n\r\n    function addHeapObject(obj) {\r\n        if (heap_next === heap.length) heap.push(heap.length + 1);\r\n        const idx = heap_next;\r\n        heap_next = heap[idx];\r\n\r\n        heap[idx] = obj;\r\n        return idx;\r\n    }\r\n    /**\r\n    * Set DeepFilterNet attenuation limit.\r\n    *\r\n    * Args:\r\n    *     - lim_db: New attenuation limit in dB.\r\n    * @param {number} st\r\n    * @param {number} lim_db\r\n    */\r\n    function df_set_atten_lim(st, lim_db) {\r\n        wasm.df_set_atten_lim(st, lim_db);\r\n    }\r\n\r\n    /**\r\n    * Get DeepFilterNet frame size in samples.\r\n    * @param {number} st\r\n    * @returns {number}\r\n    */\r\n    function df_get_frame_length(st) {\r\n        const ret = wasm.df_get_frame_length(st);\r\n        return ret >>> 0;\r\n    }\r\n\r\n    let WASM_VECTOR_LEN = 0;\r\n\r\n    function passArray8ToWasm0(arg, malloc) {\r\n        const ptr = malloc(arg.length * 1, 1) >>> 0;\r\n        getUint8Memory0().set(arg, ptr / 1);\r\n        WASM_VECTOR_LEN = arg.length;\r\n        return ptr;\r\n    }\r\n    /**\r\n    * Create a DeepFilterNet Model\r\n    *\r\n    * Args:\r\n    *     - path: File path to a DeepFilterNet tar.gz onnx model\r\n    *     - atten_lim: Attenuation limit in dB.\r\n    *\r\n    * Returns:\r\n    *     - DF state doing the full processing: stft, DNN noise reduction, istft.\r\n    * @param {Uint8Array} model_bytes\r\n    * @param {number} atten_lim\r\n    * @returns {number}\r\n    */\r\n    function df_create(model_bytes, atten_lim) {\r\n        const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc);\r\n        const len0 = WASM_VECTOR_LEN;\r\n        const ret = wasm.df_create(ptr0, len0, atten_lim);\r\n        return ret >>> 0;\r\n    }\r\n\r\n    let cachedFloat32Memory0 = null;\r\n\r\n    function getFloat32Memory0() {\r\n        if (cachedFloat32Memory0 === null || cachedFloat32Memory0.byteLength === 0) {\r\n            cachedFloat32Memory0 = new Float32Array(wasm.memory.buffer);\r\n        }\r\n        return cachedFloat32Memory0;\r\n    }\r\n\r\n    function passArrayF32ToWasm0(arg, malloc) {\r\n        const ptr = malloc(arg.length * 4, 4) >>> 0;\r\n        getFloat32Memory0().set(arg, ptr / 4);\r\n        WASM_VECTOR_LEN = arg.length;\r\n        return ptr;\r\n    }\r\n    /**\r\n    * Processes a chunk of samples.\r\n    *\r\n    * Args:\r\n    *     - df_state: Created via df_create()\r\n    *     - input: Input buffer of length df_get_frame_length()\r\n    *     - output: Output buffer of length df_get_frame_length()\r\n    *\r\n    * Returns:\r\n    *     - Local SNR of the current frame.\r\n    * @param {number} st\r\n    * @param {Float32Array} input\r\n    * @returns {Float32Array}\r\n    */\r\n    function df_process_frame(st, input) {\r\n        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);\r\n        const len0 = WASM_VECTOR_LEN;\r\n        const ret = wasm.df_process_frame(st, ptr0, len0);\r\n        return takeObject(ret);\r\n    }\r\n\r\n    function handleError(f, args) {\r\n        try {\r\n            return f.apply(this, args);\r\n        } catch (e) {\r\n            wasm.__wbindgen_exn_store(addHeapObject(e));\r\n        }\r\n    }\r\n\r\n    (typeof FinalizationRegistry === 'undefined')\r\n        ? { }\r\n        : new FinalizationRegistry(ptr => wasm.__wbg_dfstate_free(ptr >>> 0));\r\n\r\n    function __wbg_get_imports() {\r\n        const imports = {};\r\n        imports.wbg = {};\r\n        imports.wbg.__wbindgen_object_drop_ref = function(arg0) {\r\n            takeObject(arg0);\r\n        };\r\n        imports.wbg.__wbg_crypto_566d7465cdbb6b7a = function(arg0) {\r\n            const ret = getObject(arg0).crypto;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbindgen_is_object = function(arg0) {\r\n            const val = getObject(arg0);\r\n            const ret = typeof(val) === 'object' && val !== null;\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbg_process_dc09a8c7d59982f6 = function(arg0) {\r\n            const ret = getObject(arg0).process;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_versions_d98c6400c6ca2bd8 = function(arg0) {\r\n            const ret = getObject(arg0).versions;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_node_caaf83d002149bd5 = function(arg0) {\r\n            const ret = getObject(arg0).node;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbindgen_is_string = function(arg0) {\r\n            const ret = typeof(getObject(arg0)) === 'string';\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbg_require_94a9da52636aacbf = function() { return handleError(function () {\r\n            const ret = module.require;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_is_function = function(arg0) {\r\n            const ret = typeof(getObject(arg0)) === 'function';\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbindgen_string_new = function(arg0, arg1) {\r\n            const ret = getStringFromWasm0(arg0, arg1);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_msCrypto_0b84745e9245cdf6 = function(arg0) {\r\n            const ret = getObject(arg0).msCrypto;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_randomFillSync_290977693942bf03 = function() { return handleError(function (arg0, arg1) {\r\n            getObject(arg0).randomFillSync(takeObject(arg1));\r\n        }, arguments) };\r\n        imports.wbg.__wbg_getRandomValues_260cc23a41afad9a = function() { return handleError(function (arg0, arg1) {\r\n            getObject(arg0).getRandomValues(getObject(arg1));\r\n        }, arguments) };\r\n        imports.wbg.__wbg_newnoargs_e258087cd0daa0ea = function(arg0, arg1) {\r\n            const ret = new Function(getStringFromWasm0(arg0, arg1));\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_new_63b92bc8671ed464 = function(arg0) {\r\n            const ret = new Uint8Array(getObject(arg0));\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_new_9efabd6b6d2ce46d = function(arg0) {\r\n            const ret = new Float32Array(getObject(arg0));\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_buffer_12d079cc21e14bdb = function(arg0) {\r\n            const ret = getObject(arg0).buffer;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb = function(arg0, arg1, arg2) {\r\n            const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_newwithlength_e9b4878cebadb3d3 = function(arg0) {\r\n            const ret = new Uint8Array(arg0 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_set_a47bac70306a19a7 = function(arg0, arg1, arg2) {\r\n            getObject(arg0).set(getObject(arg1), arg2 >>> 0);\r\n        };\r\n        imports.wbg.__wbg_subarray_a1f73cd4b5b42fe1 = function(arg0, arg1, arg2) {\r\n            const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_newwithbyteoffsetandlength_4a659d079a1650e0 = function(arg0, arg1, arg2) {\r\n            const ret = new Float32Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_self_ce0dbfc45cf2f5be = function() { return handleError(function () {\r\n            const ret = self.self;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbg_window_c6fb939a7f436783 = function() { return handleError(function () {\r\n            const ret = window.window;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbg_globalThis_d1e6af4856ba331b = function() { return handleError(function () {\r\n            const ret = globalThis.globalThis;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbg_global_207b558942527489 = function() { return handleError(function () {\r\n            const ret = global.global;\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_is_undefined = function(arg0) {\r\n            const ret = getObject(arg0) === undefined;\r\n            return ret;\r\n        };\r\n        imports.wbg.__wbg_call_27c0f87801dedf93 = function() { return handleError(function (arg0, arg1) {\r\n            const ret = getObject(arg0).call(getObject(arg1));\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_object_clone_ref = function(arg0) {\r\n            const ret = getObject(arg0);\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbg_call_b3ca7c6051f9bec1 = function() { return handleError(function (arg0, arg1, arg2) {\r\n            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));\r\n            return addHeapObject(ret);\r\n        }, arguments) };\r\n        imports.wbg.__wbindgen_memory = function() {\r\n            const ret = wasm.memory;\r\n            return addHeapObject(ret);\r\n        };\r\n        imports.wbg.__wbindgen_throw = function(arg0, arg1) {\r\n            throw new Error(getStringFromWasm0(arg0, arg1));\r\n        };\r\n\r\n        return imports;\r\n    }\r\n\r\n    function __wbg_finalize_init(instance, module) {\r\n        wasm = instance.exports;\r\n        cachedFloat32Memory0 = null;\r\n        cachedUint8Memory0 = null;\r\n\r\n\r\n        return wasm;\r\n    }\r\n\r\n    function initSync(module) {\r\n        if (wasm !== undefined) return wasm;\r\n\r\n        const imports = __wbg_get_imports();\r\n\r\n        if (!(module instanceof WebAssembly.Module)) {\r\n            module = new WebAssembly.Module(module);\r\n        }\r\n\r\n        const instance = new WebAssembly.Instance(module, imports);\r\n\r\n        return __wbg_finalize_init(instance);\r\n    }\n\n    /**\n     * DeepFilterWorker — runs WASM processing OFF the audio render thread.\n     *\n     * Chrome uses a single audio render thread for ALL AudioContexts and tabs.\n     * Running df_create() or df_process_frame() on that thread causes buffer\n     * underruns → other apps' audio stutters on Windows (WASAPI).\n     *\n     * This Worker runs on its own thread. The AudioWorklet sends input frames\n     * via a MessagePort, this Worker processes them with WASM, and sends\n     * processed frames back. The audio thread never touches WASM.\n     *\n     * Communication: AudioWorklet ←MessagePort→ DeepFilterWorker\n     */\n    let model = null;\n    let workletPort = null;\n    // Adaptive suppression state\n    let adaptiveEnabled = false;\n    let baseSuppression = 50;\n    let minSuppression = 10;\n    let currentSuppression = 50;\n    let rmsSmoothed = 0;\n    const quietThreshold = 0.005;\n    const loudThreshold = 0.03;\n    function computeRMS(buf, len) {\n        let sum = 0;\n        for (let i = 0; i < len; i++) {\n            sum += buf[i] * buf[i];\n        }\n        return Math.sqrt(sum / len);\n    }\n    function adaptSuppression(rms) {\n        if (!model)\n            return;\n        const alpha = 0.05;\n        rmsSmoothed = rmsSmoothed * (1 - alpha) + rms * alpha;\n        let target;\n        if (rmsSmoothed <= quietThreshold) {\n            target = minSuppression;\n        }\n        else if (rmsSmoothed >= loudThreshold) {\n            target = baseSuppression;\n        }\n        else {\n            const t = (rmsSmoothed - quietThreshold) / (loudThreshold - quietThreshold);\n            target = minSuppression + t * (baseSuppression - minSuppression);\n        }\n        const rounded = Math.floor(target);\n        if (Math.abs(rounded - currentSuppression) >= 2) {\n            currentSuppression = rounded;\n            df_set_atten_lim(model.handle, rounded);\n        }\n    }\n    function processFrame(input) {\n        if (!model)\n            return input;\n        if (adaptiveEnabled) {\n            adaptSuppression(computeRMS(input, input.length));\n        }\n        return df_process_frame(model.handle, input);\n    }\n    // Handle messages from main thread (init, config) and worklet (audio frames)\n    self.onmessage = (event) => {\n        const { type } = event.data;\n        switch (type) {\n            case 'INIT': {\n                // Initialize WASM and create model — this is the heavy part\n                // Running here instead of audio thread prevents WASAPI buffer underruns\n                const { wasmModule, modelBytes, suppressionLevel } = event.data;\n                try {\n                    initSync(wasmModule);\n                    const bytes = new Uint8Array(modelBytes);\n                    const handle = df_create(bytes, suppressionLevel ?? 50);\n                    const frameLength = df_get_frame_length(handle);\n                    model = { handle, frameLength };\n                    baseSuppression = suppressionLevel ?? 50;\n                    currentSuppression = baseSuppression;\n                    self.postMessage({ type: 'READY', frameLength });\n                }\n                catch (error) {\n                    self.postMessage({ type: 'ERROR', error: String(error) });\n                }\n                break;\n            }\n            case 'SET_PORT': {\n                // Receive MessagePort for direct communication with AudioWorklet\n                workletPort = event.data.port;\n                workletPort.onmessage = (e) => {\n                    if (e.data.type === 'FRAME') {\n                        // Process audio frame and send back\n                        const processed = processFrame(e.data.samples);\n                        workletPort.postMessage({ type: 'PROCESSED', samples: processed }, [processed.buffer] // Transfer ownership — zero-copy\n                        );\n                    }\n                };\n                break;\n            }\n            case 'SET_SUPPRESSION_LEVEL': {\n                const level = Math.max(0, Math.min(100, Math.floor(event.data.value)));\n                baseSuppression = level;\n                if (!adaptiveEnabled && model) {\n                    currentSuppression = level;\n                    df_set_atten_lim(model.handle, level);\n                }\n                break;\n            }\n            case 'SET_ADAPTIVE': {\n                adaptiveEnabled = Boolean(event.data.value);\n                if (!adaptiveEnabled && model) {\n                    currentSuppression = baseSuppression;\n                    df_set_atten_lim(model.handle, baseSuppression);\n                }\n                break;\n            }\n        }\n    };\n\n})();\n";

class DeepFilterNet3Core {
    constructor(config = {}) {
        this.assets = null;
        this.workletNode = null;
        this.worker = null;
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
    startWorker() {
        this.ensureInitialized();
        if (!this.assets)
            throw new Error('Assets not loaded');
        return new Promise((resolve, reject) => {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            this.worker = new Worker(blobUrl);
            this.worker.onmessage = (event) => {
                if (event.data.type === 'READY') {
                    resolve(event.data.frameLength);
                }
                else if (event.data.type === 'ERROR') {
                    reject(new Error(event.data.error || 'Worker WASM init failed'));
                }
            };
            // Send WASM module + model to Worker for initialization
            this.worker.postMessage({
                type: 'INIT',
                wasmModule: this.assets.wasmModule,
                modelBytes: this.assets.modelBytes,
                suppressionLevel: this.config.noiseReductionLevel,
            });
        });
    }
    async createAudioWorkletNode(audioContext) {
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
    async warmup(audioContext) {
        await this.initialize();
        // Start Worker and init WASM there (off audio thread)
        const frameLength = await this.startWorker();
        // Create worklet node (lightweight — no WASM in constructor)
        const node = await this.createAudioWorkletNode(audioContext);
        // Create MessageChannel to bridge Worklet ↔ Worker
        const channel = new MessageChannel();
        // Send one port to Worker
        this.worker.postMessage({ type: 'SET_PORT', port: channel.port1 }, [channel.port1]);
        // Send other port to Worklet
        node.port.postMessage({ type: WorkletMessageTypes.SET_WORKER_PORT, port: channel.port2 }, [channel.port2]);
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
    waitForReady() {
        if (!this.workletNode) {
            return Promise.reject(new Error('No worklet node'));
        }
        return new Promise((resolve, reject) => {
            const node = this.workletNode;
            const prevHandler = node.port.onmessage;
            node.port.onmessage = (event) => {
                if (event.data?.type === 'READY') {
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
    setSuppressionLevel(level) {
        const clamped = Math.max(0, Math.min(100, Math.floor(level)));
        // Send to Worker (which owns the WASM state)
        if (this.worker) {
            this.worker.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: clamped });
        }
    }
    setNoiseSuppressionEnabled(enabled) {
        this.bypassEnabled = !enabled;
        // Send to Worklet (which controls bypass/passthrough)
        if (this.workletNode) {
            this.workletNode.port.postMessage({
                type: WorkletMessageTypes.SET_BYPASS,
                value: !enabled,
            });
        }
    }
    setAdaptiveEnabled(enabled) {
        // Send to Worker (which runs the adaptive logic)
        if (this.worker) {
            this.worker.postMessage({ type: 'SET_ADAPTIVE', value: enabled });
        }
    }
    isNoiseSuppressionEnabled() {
        return !this.bypassEnabled;
    }
    isReady() {
        return this.isInitialized && this.workletNode !== null && this.worker !== null;
    }
    get hasWorker() {
        return this.worker !== null;
    }
    get hasWorkletNode() {
        return this.workletNode !== null;
    }
    destroy() {
        if (!this.isInitialized)
            return;
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
    get workerRunning() {
        return this.processor.hasWorker;
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
