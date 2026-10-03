import type { VideoInspection } from './video-inspection.ts';
export type { VideoInspection } from './video-inspection.ts';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { buildSwiftToolEnv, compileSwiftSourceText } from './swift-cache.ts';

import { hasPlayableWebmStructure } from './video-webm.ts';

// Duration zero must pass: a recording of a fully static screen legitimately contains a single
// frame (screenrecord only encodes on screen updates), and AVFoundation reports its duration as 0.
const VIDEO_VALIDATION_SCRIPT = `
import Foundation
import AVFoundation

struct VideoInspection: Encodable {
  let status: String
  let source: String
  let reason: String?
  let sampleCount: Int?
  let mediaDurationMs: Double?
  let firstPtsMs: Double?
  let lastPtsMs: Double?
  let maxInterSampleGapMs: Double?
  let effectiveFps: Double?
}

func emit(_ inspection: VideoInspection) throws {
  let data = try JSONEncoder().encode(inspection)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\\n".utf8))
}

func invalid(_ reason: String) -> VideoInspection {
  VideoInspection(
    status: "invalid",
    source: "media-pts",
    reason: reason,
    sampleCount: nil,
    mediaDurationMs: nil,
    firstPtsMs: nil,
    lastPtsMs: nil,
    maxInterSampleGapMs: nil,
    effectiveFps: nil
  )
}

func samplePresentationTimes(_ buffer: CMSampleBuffer) -> [CMTime]? {
  let sampleCount = CMSampleBufferGetNumSamples(buffer)
  if sampleCount == 0 { return [] }
  if sampleCount == 1 { return [CMSampleBufferGetPresentationTimeStamp(buffer)] }
  var timings = Array(
    repeating: CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: .invalid,
      decodeTimeStamp: .invalid
    ),
    count: sampleCount
  )
  var entriesNeeded = 0
  let status = CMSampleBufferGetSampleTimingInfoArray(
    buffer,
    entryCount: sampleCount,
    arrayToFill: &timings,
    entriesNeededOut: &entriesNeeded
  )
  guard status == noErr else { return nil }
  if entriesNeeded == sampleCount {
    return timings.map(\\.presentationTimeStamp)
  }
  guard entriesNeeded == 1, let timing = timings.first else { return nil }
  if sampleCount == 1 { return [timing.presentationTimeStamp] }
  let durationSeconds = CMTimeGetSeconds(timing.duration)
  guard
    timing.duration.isValid,
    !timing.duration.isIndefinite,
    durationSeconds.isFinite,
    durationSeconds > 0
  else {
    return nil
  }
  var presentationTimes: [CMTime] = []
  var presentationTime = timing.presentationTimeStamp
  for _ in 0..<sampleCount {
    presentationTimes.append(presentationTime)
    presentationTime = CMTimeAdd(presentationTime, timing.duration)
  }
  return presentationTimes
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 1

Task {
  defer { semaphore.signal() }
  do {
    let playable = try await asset.load(.isPlayable)
    let duration = try await asset.load(.duration)
    guard playable, duration.isValid, !duration.isIndefinite else {
      try emit(invalid("unplayable-or-duration-invalid"))
      exitCode = 0
      return
    }
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else {
      try emit(invalid("missing-video-track"))
      exitCode = 0
      return
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    guard reader.canAdd(output) else {
      try emit(invalid("probe-failed"))
      exitCode = 0
      return
    }
    reader.add(output)
    guard reader.startReading() else {
      try emit(invalid("probe-failed"))
      exitCode = 0
      return
    }

    var samplePtsMs: [Double] = []
    while let buffer = output.copyNextSampleBuffer() {
      guard let presentationTimes = samplePresentationTimes(buffer) else {
        try emit(invalid("sample-timing-invalid"))
        exitCode = 0
        return
      }
      for pts in presentationTimes {
        let ptsMs = CMTimeGetSeconds(pts) * 1000.0
        guard pts.isValid, !pts.isIndefinite, ptsMs.isFinite else {
          try emit(invalid("sample-timing-invalid"))
          exitCode = 0
          return
        }
        samplePtsMs.append(ptsMs)
      }
    }
    guard reader.status == .completed else {
      try emit(invalid("reader-failed"))
      exitCode = 0
      return
    }

    let orderedPtsMs = samplePtsMs.sorted()
    let sampleCount = orderedPtsMs.count
    guard sampleCount > 0 else {
      try emit(invalid("missing-video-samples"))
      exitCode = 0
      return
    }
    let firstPtsMs = orderedPtsMs.first
    let lastPtsMs = orderedPtsMs.last
    var maxInterSampleGapMs: Double?
    if orderedPtsMs.count >= 2 {
      for index in 1..<orderedPtsMs.count {
        let gapMs = orderedPtsMs[index] - orderedPtsMs[index - 1]
        guard gapMs > 0 else {
          try emit(invalid("sample-timing-invalid"))
          exitCode = 0
          return
        }
        maxInterSampleGapMs = max(maxInterSampleGapMs ?? 0, gapMs)
      }
    }

    let effectiveFps: Double?
    if sampleCount >= 2, let firstPtsMs, let lastPtsMs, lastPtsMs > firstPtsMs {
      effectiveFps = Double(sampleCount - 1) * 1000.0 / (lastPtsMs - firstPtsMs)
    } else {
      effectiveFps = nil
    }
    try emit(VideoInspection(
      status: "measured",
      source: "media-pts",
      reason: nil,
      sampleCount: sampleCount,
      mediaDurationMs: max(0, CMTimeGetSeconds(duration) * 1000.0),
      firstPtsMs: firstPtsMs,
      lastPtsMs: lastPtsMs,
      maxInterSampleGapMs: maxInterSampleGapMs,
      effectiveFps: effectiveFps
    ))
    exitCode = 0
  } catch {
    do {
      try emit(invalid("probe-failed"))
      exitCode = 0
    } catch {
      exitCode = 1
    }
  }
}

semaphore.wait()
exit(exitCode)
`.trim();

export async function waitForStableFile(
  filePath: string,
  options: { pollMs?: number; attempts?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 150;
  const attempts = options.attempts ?? 12;
  let previousSize: number | undefined;
  let stableCount = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    let currentSize = 0;
    try {
      currentSize = fs.statSync(filePath).size;
    } catch {
      currentSize = 0;
    }

    if (currentSize > 0 && currentSize === previousSize) {
      stableCount += 1;
      if (stableCount >= 2) {
        return;
      }
    } else {
      stableCount = 0;
    }

    previousSize = currentSize;
    if (attempt + 1 < attempts) await sleep(pollMs, options.signal);
  }
  throw new Error('recording file did not become stable');
}

export async function isPlayableVideo(filePath: string): Promise<boolean> {
  return (await inspectVideo(filePath)).status !== 'invalid';
}

export async function inspectVideo(
  filePath: string,
  signal?: AbortSignal,
): Promise<VideoInspection> {
  const { parseVideoInspectionOutput, invalidInspection, unavailableInspection } =
    await import('./video-inspection.ts');
  signal?.throwIfAborted();
  const container = await readVideoContainerKind(filePath);
  signal?.throwIfAborted();
  if (!container) return invalidInspection('container-invalid');
  // AVFoundation is the MP4 semantic validator. It does not reliably load WebM on supported
  // macOS hosts, so WebM completion is established by its EBML document type + Segment marker.
  if (container === 'webm') return unavailableInspection('unsupported-container');
  try {
    const validatorPath = await getVideoValidatorExecutablePath(signal);
    signal?.throwIfAborted();
    const result = await runCmd(validatorPath, [filePath], {
      allowFailure: true,
      timeoutMs: 10_000,
      env: buildSwiftToolEnv(),
      signal,
    });
    signal?.throwIfAborted();
    if (result.exitCode === 0) {
      return parseVideoInspectionOutput(result.stdout) ?? invalidInspection('probe-failed');
    }
    return isSwiftVideoValidatorUnavailable(result.stderr, result.stdout)
      ? unavailableInspection('validator-unavailable')
      : invalidInspection('probe-failed');
  } catch (error) {
    signal?.throwIfAborted();
    if (isSwiftVideoValidatorError(error)) {
      return unavailableInspection('validator-unavailable');
    }
    return invalidInspection('probe-failed');
  }
}

async function getVideoValidatorExecutablePath(signal?: AbortSignal): Promise<string> {
  return await compileSwiftSourceText({
    source: VIDEO_VALIDATION_SCRIPT,
    cacheName: 'video-validator',
    timeoutMs: 30_000,
    signal,
  });
}

function isSwiftVideoValidatorError(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }
  if (error.code === 'TOOL_MISSING') {
    return true;
  }
  return isSwiftVideoValidatorUnavailable(
    String(error.details?.stderr ?? ''),
    String(error.details?.stdout ?? ''),
  );
}

export async function waitForPlayableVideo(
  filePath: string,
  options: { pollMs?: number; attempts?: number; signal?: AbortSignal } = {},
): Promise<VideoInspection> {
  const { invalidInspection } = await import('./video-inspection.ts');
  const pollMs = options.pollMs ?? 150;
  const attempts = options.attempts ?? 12;
  let inspection: VideoInspection = invalidInspection('container-invalid');

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    inspection = await inspectVideo(filePath, options.signal);
    if (inspection.status !== 'invalid') {
      return inspection;
    }
    if (attempt + 1 < attempts) await sleep(pollMs, options.signal);
  }
  return inspection;
}

function isSwiftVideoValidatorUnavailable(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`;
  return /\b(no such module ['"]AVFoundation['"]|unable to find utility ["']swiftc?["']|xcrun: error: unable to find utility ["']swiftc?["'])\b/i.test(
    combined,
  );
}

/**
 * The container sniff alone: `ftyp` and `moov` for MP4, the EBML segment for WebM. It reads the file and
 * spawns nothing, which is what lets a stop check a copy before it trusts it (ADR 0024 2.3).
 */
export async function hasVideoContainer(filePath: string): Promise<boolean> {
  return (await readVideoContainerKind(filePath)) !== undefined;
}

/**
 * Which video container a file actually is, sniffed from its bytes rather than its name. Callers
 * that can only decode one container ask this before they spawn a decoder, because a `.mp4` that
 * is not an MP4 and a WebM that is named well both answer differently.
 */
export async function readVideoContainerKind(
  filePath: string,
): Promise<'mp4' | 'webm' | undefined> {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  if (filePath.toLowerCase().endsWith('.webm')) {
    return hasPlayableWebmStructure(filePath) ? 'webm' : undefined;
  }
  return (await isMp4Container(filePath)) ? 'mp4' : undefined;
}

// Loaded on the first validated file rather than on import: this scan is what a recording
// completion asks for, and nothing that merely imports this module should evaluate it.
async function isMp4Container(filePath: string): Promise<boolean> {
  const { findMp4Atom } = await import('./mp4-atoms.ts');
  return (
    findMp4Atom(filePath, ['ftyp']) !== undefined && findMp4Atom(filePath, ['moov']) !== undefined
  );
}
