/**
 * RNNoise AudioWorklet Processor
 *
 * RNNoise WASM 모듈을 AudioWorklet 내부에서 실행하여
 * 실시간 딥러닝 기반 노이즈 제거를 수행합니다.
 *
 * RNNoise는 480 샘플(48kHz 기준 10ms) 프레임 단위로 처리합니다.
 */

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.enabled = true;
    this.wasmReady = false;
    this.module = null;
    this.state = null;

    // RNNoise 프레임 크기: 480 샘플 (48kHz에서 10ms)
    this.FRAME_SIZE = 480;
    this.inputBuffer = new Float32Array(0);
    this.outputBuffer = new Float32Array(0);

    // WASM 모듈 경로
    this.wasmPath = options.processorOptions?.wasmPath || '';

    // 메시지 핸들러
    this.port.onmessage = (event) => {
      if (event.data.type === 'SET_ENABLED') {
        this.enabled = event.data.enabled;
      }
      if (event.data.type === 'WASM_MODULE') {
        this.initWasm(event.data.wasmBytes);
      }
    };
  }

  async initWasm(wasmBytes) {
    try {
      // WASM 모듈 인스턴스화
      const wasmModule = await WebAssembly.compile(wasmBytes);

      // RNNoise WASM 메모리 설정
      const memory = new WebAssembly.Memory({ initial: 10, maximum: 100 });

      const importObject = {
        env: {
          memory: memory,
          // RNNoise가 요구하는 math 함수들
          expf: Math.exp,
          sinf: Math.sin,
          cosf: Math.cos,
          logf: Math.log,
          sqrtf: Math.sqrt,
          floorf: Math.floor,
          ceilf: Math.ceil,
          fabsf: Math.abs,
          powf: Math.pow,
          tanhf: Math.tanh,
          // abort 핸들러
          abort: () => console.error('[RNNoise] WASM abort'),
        },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_close: () => 0,
          fd_write: () => 0,
          fd_seek: () => 0,
        }
      };

      const instance = await WebAssembly.instantiate(wasmModule, importObject);
      this.module = instance.exports;

      // RNNoise 상태 초기화
      if (this.module.rnnoise_create) {
        this.state = this.module.rnnoise_create();
        this.wasmReady = true;

        // 입출력 버퍼 포인터 설정
        if (this.module.malloc) {
          this.inputPtr = this.module.malloc(this.FRAME_SIZE * 4); // float32
          this.outputPtr = this.module.malloc(this.FRAME_SIZE * 4);
        }

        this.port.postMessage({ type: 'WASM_READY' });
        console.log('[RNNoise] WASM 초기화 완료');
      }
    } catch (e) {
      console.error('[RNNoise] WASM 초기화 실패:', e);
      this.port.postMessage({ type: 'WASM_ERROR', error: e.message });
    }
  }

  /**
   * WASM 없이도 동작하는 간단한 노이즈 게이트
   * (WASM 로드 실패 시 폴백)
   */
  simpleNoiseGate(input, threshold) {
    const output = new Float32Array(input.length);
    const thresholdLinear = Math.pow(10, threshold / 20);

    for (let i = 0; i < input.length; i++) {
      if (Math.abs(input[i]) > thresholdLinear) {
        output[i] = input[i];
      } else {
        // 부드러운 감쇠
        output[i] = input[i] * 0.1;
      }
    }
    return output;
  }

  /**
   * 스펙트럼 기반 노이즈 억제 (간이 버전)
   * WASM 로드 전에도 기본적인 노이즈 제거 수행
   */
  spectralNoiseSuppress(input) {
    // 간단한 지수 이동 평균 노이즈 추정
    if (!this._noiseEstimate) {
      this._noiseEstimate = new Float32Array(input.length);
      this._alpha = 0.98;
      this._initialized = false;
    }

    const output = new Float32Array(input.length);

    for (let i = 0; i < input.length; i++) {
      const absSample = Math.abs(input[i]);

      if (!this._initialized) {
        this._noiseEstimate[i] = absSample;
      } else {
        // 노이즈 레벨은 천천히 추적
        if (absSample < this._noiseEstimate[i] * 2) {
          this._noiseEstimate[i] = this._alpha * this._noiseEstimate[i] +
            (1 - this._alpha) * absSample;
        }
      }

      // 스펙트럼 차감 (간이 버전)
      const noiseLevel = this._noiseEstimate[i] * 1.5;
      if (absSample > noiseLevel) {
        output[i] = input[i];
      } else {
        output[i] = input[i] * Math.max(0, 1 - noiseLevel / (absSample + 1e-10)) * 0.3;
      }
    }

    this._initialized = true;
    return output;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !this.enabled) {
      // 비활성화 시 패스스루
      if (input && input[0] && output && output[0]) {
        output[0].set(input[0]);
      }
      return true;
    }

    const inputData = input[0];

    if (this.wasmReady && this.module && this.state) {
      // ── RNNoise WASM 처리 ──
      // 입력 버퍼에 추가
      const newBuffer = new Float32Array(this.inputBuffer.length + inputData.length);
      newBuffer.set(this.inputBuffer);
      newBuffer.set(inputData, this.inputBuffer.length);
      this.inputBuffer = newBuffer;

      // 출력 결과 수집
      let processedChunks = [];

      while (this.inputBuffer.length >= this.FRAME_SIZE) {
        const frame = this.inputBuffer.slice(0, this.FRAME_SIZE);
        this.inputBuffer = this.inputBuffer.slice(this.FRAME_SIZE);

        try {
          // WASM 메모리에 데이터 쓰기
          const heap = new Float32Array(this.module.memory.buffer);
          const inputOffset = this.inputPtr / 4;
          const outputOffset = this.outputPtr / 4;

          // RNNoise는 short 범위(-32768~32767) 입력 기대
          for (let i = 0; i < this.FRAME_SIZE; i++) {
            heap[inputOffset + i] = frame[i] * 32768;
          }

          // RNNoise 처리
          this.module.rnnoise_process_frame(this.state, this.outputPtr, this.inputPtr);

          // 결과 읽기 및 float 범위로 복원
          const resultFrame = new Float32Array(this.FRAME_SIZE);
          for (let i = 0; i < this.FRAME_SIZE; i++) {
            resultFrame[i] = heap[outputOffset + i] / 32768;
          }

          processedChunks.push(resultFrame);
        } catch (e) {
          // WASM 처리 실패 시 폴백
          processedChunks.push(this.spectralNoiseSuppress(frame));
        }
      }

      // 처리된 데이터를 출력 버퍼에 합성
      if (processedChunks.length > 0) {
        const totalProcessed = new Float32Array(
          processedChunks.reduce((sum, c) => sum + c.length, 0)
        );
        let offset = 0;
        for (const chunk of processedChunks) {
          totalProcessed.set(chunk, offset);
          offset += chunk.length;
        }

        // 출력 버퍼에 추가
        const newOutputBuffer = new Float32Array(this.outputBuffer.length + totalProcessed.length);
        newOutputBuffer.set(this.outputBuffer);
        newOutputBuffer.set(totalProcessed, this.outputBuffer.length);
        this.outputBuffer = newOutputBuffer;
      }

      // 출력 채널에 데이터 쓰기
      if (this.outputBuffer.length >= output[0].length) {
        output[0].set(this.outputBuffer.slice(0, output[0].length));
        this.outputBuffer = this.outputBuffer.slice(output[0].length);
      } else if (this.outputBuffer.length > 0) {
        output[0].set(this.outputBuffer, 0);
        this.outputBuffer = new Float32Array(0);
      } else {
        output[0].set(inputData);
      }
    } else {
      // ── WASM 미로드: 폴백 노이즈 억제 ──
      const processed = this.spectralNoiseSuppress(inputData);
      output[0].set(processed);
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
