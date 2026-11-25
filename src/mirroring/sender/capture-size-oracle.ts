/**
 * The part of Chromium's `VideoCaptureOracle` (media/capture/content/video_capture_oracle.cc) that turns consumer
 * resource-utilization feedback into a capture size, with its helpers `CaptureResolutionChooser`
 * (capture_resolution_chooser.cc) and `FeedbackSignalAccumulator` (media/base/feedback_signal_accumulator.h).
 *
 * In Chrome this runs in the viz process, inside `FrameSinkVideoCapturerImpl`, which is what captures a tab: the
 * Mirroring Service's `VideoCaptureClient::ProcessFeedback` hands the utilization `VideoSender` reports to the next
 * buffer it releases, and the oracle answers by proposing a smaller (or larger) capture size, always one of the
 * snapped sizes of the chooser. WebCodecs has no way to send that feedback to a capture device, so the oracle runs
 * in the engine and the capture agent encodes at the size it proposes; see DESIGN.md.
 *
 * Not ported: the samplers (`SmoothEventSampler`, `AnimatedContentSampler`), which decide which compositor updates
 * become frames and need damage rectangles the capture page cannot see, and the max-frame-rate and max-pixels
 * feedback `VideoSender` never reports. Times are milliseconds.
 */

export interface Size {
  width: number;
  height: number;
}

const area = (s: Size): number => s.width * s.height;
const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;
const isEmpty = (s: Size): boolean => s.width <= 0 || s.height <= 0;
/** `base::saturated_cast<int>` of a double. */
const saturatedInt = (v: number): number => (Number.isNaN(v) ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(v))));
/** `RoundedDivision` of media/base/video_util.cc. */
const roundedDivision = (a: number, b: number): number => Math.floor((a + Math.floor(b / 2)) / b);

/** `ScaleSizeToFitWithinTarget` and `ScaleSizeToEncompassTarget`, which share `ScaleSizeToTarget`. */
function scaleSizeToTarget(size: Size, target: Size, fitWithin: boolean): Size {
  if (isEmpty(size)) return { width: 0, height: 0 };
  const x = size.width * target.height;
  const y = size.height * target.width;
  const useTargetWidth = fitWithin ? y < x : x < y;
  return useTargetWidth
    ? { width: target.width, height: roundedDivision(y, size.width) }
    : { width: roundedDivision(x, size.height), height: target.height };
}

/** `PadToMatchAspectRatio`. */
function padToMatchAspectRatio(size: Size, target: Size): Size {
  if (isEmpty(target)) return { width: 0, height: 0 };
  const x = size.width * target.height;
  const y = size.height * target.width;
  if (x < y) return { width: roundedDivision(y, target.height), height: size.height };
  return { width: size.width, height: roundedDivision(x, target.width) };
}

/** `ComputeBoundedCaptureSize`. */
function computeBoundedCaptureSize(size: Size, min: Size, max: Size): Size {
  if (size.width > max.width || size.height > max.height) {
    const result = scaleSizeToTarget(size, max, true);
    return { width: Math.max(result.width, min.width), height: Math.max(result.height, min.height) };
  }
  if (size.width < min.width || size.height < min.height) {
    const result = scaleSizeToTarget(size, min, false);
    return { width: Math.min(result.width, max.width), height: Math.min(result.height, max.height) };
  }
  return size;
}

/** `kDefaultCaptureSize`, `kSnappedHeightStep`, `kMinAreaDecreasePercent`. */
const DEFAULT_CAPTURE_SIZE: Size = { width: 640, height: 360 };
const SNAPPED_HEIGHT_STEP = 90;
const MIN_AREA_DECREASE_PERCENT = 15;

/** `CaptureResolutionChooser`: the snapped sizes between the constraints and the one nearest a target area. */
export class CaptureResolutionChooser {
  private minFrameSize = DEFAULT_CAPTURE_SIZE;
  private maxFrameSize = DEFAULT_CAPTURE_SIZE;
  private applyAspectRatioAdjustment = false;
  private sourceSize: Size = { width: 0, height: 0 };
  private targetArea = Number.MAX_SAFE_INTEGER;
  private currentCaptureSize = DEFAULT_CAPTURE_SIZE;
  private snappedSizes: Size[] = [DEFAULT_CAPTURE_SIZE];

  get captureSize(): Size {
    return this.currentCaptureSize;
  }

  setConstraints(min: Size, max: Size, useFixedAspectRatio: boolean): void {
    this.minFrameSize = min;
    this.maxFrameSize = max;
    this.applyAspectRatioAdjustment = !sameSize(min, max) && useFixedAspectRatio;
    this.updateSnappedFrameSizes();
    this.recomputeCaptureSize();
  }

  setSourceSize(size: Size): void {
    this.sourceSize = size;
    this.updateSnappedFrameSizes();
    this.recomputeCaptureSize();
  }

  setTargetFrameArea(a: number): void {
    this.targetArea = a;
    this.recomputeCaptureSize();
  }

  /** `FindNearestFrameSize`. */
  findNearestFrameSize(a: number): Size {
    const sizes = this.snappedSizes;
    const p = lowerBound(sizes, a);
    if (p === sizes.length) return sizes[sizes.length - 1]!;
    if (p === 0) return sizes[0]!;
    const above = sizes[p]!;
    const below = sizes[p - 1]!;
    return area(above) - a < a - area(below) ? above : below;
  }

  /** `FindLargerFrameSize`. */
  findLargerFrameSize(a: number, numStepsUp: number): Size {
    const sizes = this.snappedSizes;
    let p = 0;
    while (p < sizes.length && area(sizes[p]!) <= a) p++; // upper_bound
    const additional = numStepsUp - 1;
    return sizes.length - p > additional ? sizes[p + additional]! : sizes[sizes.length - 1]!;
  }

  /** `FindSmallerFrameSize`. */
  findSmallerFrameSize(a: number, numStepsDown: number): Size {
    const sizes = this.snappedSizes;
    const p = lowerBound(sizes, a);
    return p >= numStepsDown ? sizes[p - numStepsDown]! : sizes[0]!;
  }

  private recomputeCaptureSize(): void {
    this.currentCaptureSize = this.findNearestFrameSize(this.targetArea);
  }

  private updateSnappedFrameSizes(): void {
    const source = isEmpty(this.sourceSize) ? this.currentCaptureSize : this.sourceSize;
    const constrained = computeBoundedCaptureSize(
      this.applyAspectRatioAdjustment ? padToMatchAspectRatio(source, this.maxFrameSize) : source,
      this.minFrameSize,
      this.maxFrameSize,
    );
    const sizes: Size[] = [constrained];
    let lastArea = area(constrained);
    for (let height = constrained.height - SNAPPED_HEIGHT_STEP; height >= this.minFrameSize.height; height -= SNAPPED_HEIGHT_STEP) {
      const width = Math.trunc((height * constrained.width) / constrained.height);
      if (width < this.minFrameSize.width) break;
      const smaller = width * height;
      const percentDecrease = Math.trunc((100 * (lastArea - smaller)) / lastArea);
      if (percentDecrease >= MIN_AREA_DECREASE_PERCENT) {
        sizes.push({ width, height });
        lastArea = smaller;
      }
    }
    this.snappedSizes = sizes.reverse();
  }
}

/** `std::lower_bound` by area over sizes sorted from smallest to largest: the first whose area is not less than `a`. */
function lowerBound(sizes: Size[], a: number): number {
  let lo = 0;
  let hi = sizes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (area(sizes[mid]!) < a) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `FeedbackSignalAccumulator`: an exponentially decaying average of values that arrive at irregular times. */
export class FeedbackSignalAccumulator {
  private readonly halfLifeMs: number;
  private average = NaN;
  private updateValue = 0;
  private priorAverage = 0;
  resetTime = 0;
  updateTime = 0;
  private priorUpdateTime = 0;

  constructor(halfLifeMs: number) {
    this.halfLifeMs = halfLifeMs;
  }

  reset(startingValue: number, timestamp: number): void {
    this.average = this.updateValue = this.priorAverage = startingValue;
    this.resetTime = this.updateTime = this.priorUpdateTime = timestamp;
  }

  /** False when the timestamp is out of order and the value was ignored. */
  update(value: number, timestamp: number): boolean {
    if (timestamp < this.updateTime) return false;
    if (timestamp === this.updateTime) {
      if (timestamp === this.resetTime) {
        this.average = this.updateValue = this.priorAverage = Math.max(value, this.updateValue);
        return true;
      }
      if (value <= this.updateValue) return true;
      this.updateValue = value;
    } else {
      this.priorAverage = this.average;
      this.priorUpdateTime = this.updateTime;
      this.updateValue = value;
      this.updateTime = timestamp;
    }
    const elapsed = this.updateTime - this.priorUpdateTime;
    const weight = elapsed / (elapsed + this.halfLifeMs);
    this.average = weight * this.updateValue + (1 - weight) * this.priorAverage;
    return true;
  }

  get current(): number {
    return this.average;
  }
}

/** `kDefaultMinCapturePeriod`, `kDefaultMinSizeChangePeriod`, `kUpperBoundsDurationEstimate`. */
const DEFAULT_MIN_CAPTURE_PERIOD_MS = 200;
const DEFAULT_MIN_SIZE_CHANGE_PERIOD_MS = 3000;
const UPPER_BOUNDS_DURATION_ESTIMATE_MS = 1000;
/** `kBufferUtilizationEvaluationInterval`, `kConsumerCapabilityEvaluationInterval`, `kMaxTimeSinceLastFeedbackUpdate`. */
const BUFFER_UTILIZATION_EVALUATION_INTERVAL_MS = 200;
const CONSUMER_CAPABILITY_EVALUATION_INTERVAL_MS = 1000;
const MAX_TIME_SINCE_LAST_FEEDBACK_UPDATE_MS = 1000;
/** `kDebouncingPeriodForAnimatedContent`, `kProvingPeriodForAnimatedContent`. */
const DEBOUNCING_PERIOD_FOR_ANIMATED_CONTENT_MS = 3000;
const PROVING_PERIOD_FOR_ANIMATED_CONTENT_MS = 30_000;
/** `kMaxFrameTimestamps`. */
const MAX_FRAME_TIMESTAMPS = 16;

type ThrottlingMode = "disabled" | "enabled" | "active";

export interface CaptureSizeOracleOptions {
  /** `VideoCaptureParams::SuggestConstraints` of the session's capture parameters. */
  minSize: Size;
  maxSize: Size;
  /** `fixed_aspect_ratio` of those constraints (the `FIXED_ASPECT_RATIO` resolution change policy). */
  fixedAspectRatio: boolean;
  /** `SetMinCapturePeriod`: one over the requested frame rate. */
  minCapturePeriodMs: number;
}

export class CaptureSizeOracle {
  private readonly chooser = new CaptureResolutionChooser();
  private throttling: ThrottlingMode = "enabled";
  private readonly minSizeChangePeriodMs = DEFAULT_MIN_SIZE_CHANGE_PERIOD_MS;
  private readonly minCapturePeriodMs: number;
  private currentCaptureSize: Size;
  private nextFrame = 0;
  private sourceSizeOrEmpty: Size = { width: 0, height: 0 };
  private readonly frameTimestamps = Array.from({ length: MAX_FRAME_TIMESTAMPS }, () => 0);
  private readonly bufferPoolUtilization = new FeedbackSignalAccumulator(BUFFER_UTILIZATION_EVALUATION_INTERVAL_MS);
  private readonly estimatedCapableArea = new FeedbackSignalAccumulator(CONSUMER_CAPABILITY_EVALUATION_INTERVAL_MS);
  private startTimeOfUnderutilization = 0;
  private sourceSizeChangeTime = 0;
  private lastTimeAnimationWasDetected = 0;
  private durationOfNextFrameMs = 0;

  constructor(options: CaptureSizeOracleOptions) {
    this.minCapturePeriodMs = options.minCapturePeriodMs > 0 ? options.minCapturePeriodMs : DEFAULT_MIN_CAPTURE_PERIOD_MS;
    this.chooser.setConstraints(options.minSize, options.maxSize, options.fixedAspectRatio);
    this.currentCaptureSize = this.chooser.captureSize;
  }

  /** The capture size the client should use, `capture_size()`. */
  get captureSize(): Size {
    return this.currentCaptureSize;
  }

  /** Number of the frame the next `recordCapture` belongs to, `next_frame_number()`. */
  get nextFrameNumber(): number {
    return this.nextFrame;
  }

  get isThrottlingActive(): boolean {
    return this.throttling === "active";
  }

  /** `SetSourceSize`. */
  setSourceSize(size: Size): void {
    if (sameSize(size, this.sourceSizeOrEmpty)) return;
    this.sourceSizeOrEmpty = size;
    this.chooser.setSourceSize(size);
    this.sourceSizeChangeTime = this.nextFrame === 0 ? 0 : this.frameTimestamp(this.nextFrame - 1);
  }

  /**
   * The part of `ObserveEventAndDecideCapture` that follows a decision to sample: the frame's duration estimate, the
   * commit of a new capture size, and the frame's timestamp. `animationDetected` stands in for
   * `AnimatedContentSampler::HasProposal`.
   */
  observeEvent(eventTimeMs: number, animationDetected: boolean): void {
    if (animationDetected) this.lastTimeAnimationWasDetected = eventTimeMs;
    this.durationOfNextFrameMs = 0;
    if (this.nextFrame > 0) this.durationOfNextFrameMs = eventTimeMs - this.frameTimestamp(this.nextFrame - 1);
    this.durationOfNextFrameMs = Math.max(Math.min(this.durationOfNextFrameMs, UPPER_BOUNDS_DURATION_ESTIMATE_MS), this.minCapturePeriodMs);

    if (this.nextFrame === 0) {
      this.commitCaptureSizeAndReset(eventTimeMs - this.durationOfNextFrameMs);
    } else if (!sameSize(this.currentCaptureSize, this.chooser.captureSize)) {
      const timeSinceLastChange = eventTimeMs - this.bufferPoolUtilization.resetTime;
      // Unless auto-throttling has become active the resolution should change as soon as possible.
      if (timeSinceLastChange >= this.minSizeChangePeriodMs || this.throttling !== "active") {
        this.commitCaptureSizeAndReset(this.frameTimestamp(this.nextFrame - 1));
      }
    }
    this.setFrameTimestamp(this.nextFrame, eventTimeMs);
  }

  /** `RecordCapture`. `poolUtilization` is the share of the pipeline in use, `FrameSinkVideoCapturerImpl::GetPipelineUtilization`. */
  recordCapture(poolUtilization: number): void {
    const timestamp = this.frameTimestamp(this.nextFrame);
    if (this.throttling === "active") {
      this.bufferPoolUtilization.update(poolUtilization, timestamp);
      this.analyzeAndAdjust(timestamp);
    }
    this.nextFrame++;
  }

  /** `RecordConsumerFeedback`, for the resource utilization of one frame. */
  recordConsumerFeedback(frameNumber: number, resourceUtilization: number): void {
    // Max pixels and max frame rate feedback is never produced by `VideoSender`.
    if (this.throttling === "disabled") return;
    if (!Number.isFinite(resourceUtilization)) return;
    // Non-positive values are normal, meaning N/A.
    if (resourceUtilization <= 0) return;

    if (this.throttling !== "active") this.throttling = "active";

    if (!this.isFrameInRecentHistory(frameNumber)) return;
    const timestamp = this.frameTimestamp(frameNumber);

    // Utilization is at most linearly proportional to area and typically sublinear; the more conservative (linear)
    // assumption converges to the right place all the same.
    const areaAtFullUtilization = saturatedInt(area(this.currentCaptureSize) / resourceUtilization);
    this.estimatedCapableArea.update(areaAtFullUtilization, timestamp);
  }

  private frameTimestamp(frameNumber: number): number {
    return this.frameTimestamps[frameNumber % MAX_FRAME_TIMESTAMPS]!;
  }

  private setFrameTimestamp(frameNumber: number, timestamp: number): void {
    this.frameTimestamps[frameNumber % MAX_FRAME_TIMESTAMPS] = timestamp;
  }

  private isFrameInRecentHistory(frameNumber: number): boolean {
    return frameNumber >= 0 && frameNumber <= this.nextFrame && this.nextFrame - frameNumber < MAX_FRAME_TIMESTAMPS;
  }

  /** `CommitCaptureSizeAndReset`: start every short-term accumulator from a stable state. */
  private commitCaptureSizeAndReset(lastFrameTime: number): void {
    this.currentCaptureSize = this.chooser.captureSize;
    const ignoreBefore = lastFrameTime + 0.001;
    this.bufferPoolUtilization.reset(1.0, ignoreBefore);
    this.estimatedCapableArea.reset(area(this.currentCaptureSize), ignoreBefore);
  }

  /** `AnalyzeAndAdjust`. */
  private analyzeAndAdjust(analyzeTime: number): void {
    const decreased = this.analyzeForDecreasedArea(analyzeTime);
    if (decreased > 0) {
      this.chooser.setTargetFrameArea(decreased);
      return;
    }
    const increased = this.analyzeForIncreasedArea(analyzeTime);
    if (increased > 0) {
      this.chooser.setTargetFrameArea(increased);
      return;
    }
    // Cancel an earlier proposal that conditions no longer support.
    this.chooser.setTargetFrameArea(area(this.currentCaptureSize));
  }

  /** `AnalyzeForDecreasedArea`: -1 when the capture size is sustainable. */
  private analyzeForDecreasedArea(analyzeTime: number): number {
    const currentArea = area(this.currentCaptureSize);
    let bufferCapableArea = currentArea;
    if (this.hasSufficientRecentFeedback(this.bufferPoolUtilization, analyzeTime) && this.bufferPoolUtilization.current > 1.0) {
      bufferCapableArea = Math.trunc(currentArea / this.bufferPoolUtilization.current);
    }
    let consumerCapableArea = currentArea;
    if (this.hasSufficientRecentFeedback(this.estimatedCapableArea, analyzeTime)) {
      consumerCapableArea = saturatedInt(this.estimatedCapableArea.current);
    }

    let decreased = -1;
    const capableArea = Math.min(bufferCapableArea, consumerCapableArea);
    if (capableArea < currentArea) {
      // At least one step down.
      decreased = Math.min(capableArea, area(this.chooser.findSmallerFrameSize(currentArea, 1)));
      this.startTimeOfUnderutilization = 0;
    }
    return decreased;
  }

  /** `AnalyzeForIncreasedArea`: -1 when the capture size should stay. */
  private analyzeForIncreasedArea(analyzeTime: number): number {
    const currentArea = area(this.currentCaptureSize);
    const increasedArea = area(this.chooser.findLargerFrameSize(currentArea, 1));
    if (increasedArea <= currentArea) return -1;

    if (!this.hasSufficientRecentFeedback(this.bufferPoolUtilization, analyzeTime)) return -1;
    if (this.bufferPoolUtilization.current > 0) {
      const bufferCapableArea = saturatedInt(currentArea / this.bufferPoolUtilization.current);
      if (bufferCapableArea < increasedArea) {
        this.startTimeOfUnderutilization = 0;
        return -1;
      }
    }

    if (this.hasSufficientRecentFeedback(this.estimatedCapableArea, analyzeTime)) {
      if (this.estimatedCapableArea.current < increasedArea) {
        this.startTimeOfUnderutilization = 0;
        return -1;
      }
    } else if (this.estimatedCapableArea.updateTime === this.estimatedCapableArea.resetTime) {
      // The consumer gave no feedback since the size changed: its capability is not a consideration.
    } else {
      // It reports feedback but not recently: it may have stalled, so do not make things worse.
      return -1;
    }

    // Under-utilized from here on.
    if (this.startTimeOfUnderutilization === 0) this.startTimeOfUnderutilization = analyzeTime;

    // Soon after a source size change an immediate increase lets the system step up to its ideal point quickly.
    if (this.startTimeOfUnderutilization - this.sourceSizeChangeTime <= 3 * this.minSizeChangePeriodMs) return increasedArea;

    // While content animates, a long proving period of under-utilization comes first, so a rise in data volume does not
    // drop frames.
    if (analyzeTime - this.lastTimeAnimationWasDetected < DEBOUNCING_PERIOD_FOR_ANIMATED_CONTENT_MS) {
      if (analyzeTime - this.startTimeOfUnderutilization < PROVING_PERIOD_FOR_ANIMATED_CONTENT_MS) return -1;
      this.startTimeOfUnderutilization = 0;
      return increasedArea;
    }

    // Non-animating content: quality can improve at once, frame drops matter little.
    return increasedArea;
  }

  /** `HasSufficientRecentFeedback`. */
  private hasSufficientRecentFeedback(accumulator: FeedbackSignalAccumulator, now: number): boolean {
    const amountOfHistory = accumulator.updateTime - accumulator.resetTime;
    return amountOfHistory >= this.minSizeChangePeriodMs && now - accumulator.updateTime <= MAX_TIME_SINCE_LAST_FEEDBACK_UPDATE_MS;
  }
}

/**
 * `VideoCaptureParams::SuggestConstraints` (media/capture/video_capture_types.cc): the requested size is the maximum
 * (rounded down to even numbers); the minimum follows the resolution change policy.
 */
export function suggestConstraints(
  requested: Size,
  policy: "fixed_resolution" | "fixed_aspect_ratio" | "any_within_limit",
): { minSize: Size; maxSize: Size; fixedAspectRatio: boolean } {
  const maxSize = { width: requested.width - (requested.width % 2), height: requested.height - (requested.height % 2) };
  let minSize: Size = { width: 0, height: 0 };
  switch (policy) {
    case "fixed_resolution":
      minSize = maxSize;
      break;
    case "fixed_aspect_ratio": {
      const kMinLines = 180;
      if (maxSize.height <= kMinLines) {
        minSize = maxSize;
      } else {
        const idealWidth = (kMinLines * maxSize.width) / maxSize.height;
        const evenWidth = Math.trunc(idealWidth / 2 + 0.5) * 2;
        minSize = { width: evenWidth, height: kMinLines };
        if (minSize.width <= 0 || minSize.width > maxSize.width) minSize = maxSize;
      }
      break;
    }
    case "any_within_limit":
      if (!isEmpty(maxSize)) minSize = { width: 2, height: 2 };
      break;
  }
  return { minSize, maxSize, fixedAspectRatio: policy === "fixed_aspect_ratio" };
}
