"use client";

type OpusMediaRecorderCtor = new (
  stream: MediaStream,
  options?: MediaRecorderOptions,
  workerOptions?: {
    encoderWorkerFactory?: () => Worker;
    OggOpusEncoderWasmPath?: string;
    WebMOpusEncoderWasmPath?: string;
  },
) => MediaRecorder;

let OpusMediaRecorderClass: OpusMediaRecorderCtor | null = null;

async function loadOpusMediaRecorder(): Promise<OpusMediaRecorderCtor> {
  if (OpusMediaRecorderClass) return OpusMediaRecorderClass;
  const mod = await import("opus-media-recorder");
  OpusMediaRecorderClass = (mod.default || mod) as OpusMediaRecorderCtor;
  return OpusMediaRecorderClass;
}

function workerOptions() {
  return {
    encoderWorkerFactory: () =>
      new Worker("/opus-media-recorder/encoderWorker.umd.js"),
    OggOpusEncoderWasmPath: "/opus-media-recorder/OggOpusEncoder.wasm",
    WebMOpusEncoderWasmPath: "/opus-media-recorder/WebMOpusEncoder.wasm",
  };
}

/** Prefer native OGG; otherwise OpusMediaRecorder polyfill (Chrome). */
export async function createVoiceRecorder(stream: MediaStream): Promise<{
  recorder: MediaRecorder;
  mimeType: string;
}> {
  if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
    return {
      recorder: new MediaRecorder(stream, { mimeType: "audio/ogg;codecs=opus" }),
      mimeType: "audio/ogg;codecs=opus",
    };
  }
  if (MediaRecorder.isTypeSupported("audio/ogg")) {
    return {
      recorder: new MediaRecorder(stream, { mimeType: "audio/ogg" }),
      mimeType: "audio/ogg",
    };
  }

  const OpusMR = await loadOpusMediaRecorder();
  const mimeType = "audio/ogg";
  const recorder = new OpusMR(
    stream,
    { mimeType, audioBitsPerSecond: 32000 },
    workerOptions(),
  );
  return { recorder, mimeType };
}
