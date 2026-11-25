/**
 * Chrome's media router log (`LoggerImpl`, components/media_router/browser/logger_impl.cc), the one behind
 * `chrome://media-router-internals`: a ring of the last 1000 entries, each with a severity, a category, the component
 * that wrote it and the sink, source and session it is about.
 */

/** `LoggerImpl::Severity`, as `AsString` writes it. */
export type LogSeverity = "Info" | "Warning" | "Error";

/** `mojom::LogCategory`, as `AsString` writes it. */
export type LogCategory = "Discovery" | "Route" | "Mirroring" | "UI";

/** `LoggerImpl::AsValue`: one entry, with the same field names. */
export interface LogEntry {
  severity: LogSeverity;
  category: LogCategory;
  /** `base::TimeFormatTimeOfDayWithMilliseconds`: `HH:MM:SS.mmm`, local time. */
  time: string;
  /** Usually the name of the class that wrote the entry. */
  component: string;
  message: string;
  /** Empty when the entry is not about a sink. */
  sinkId: string;
  /** Empty when the entry is not about a media source. */
  mediaSource: string;
  /** Empty when the entry is not about a session. */
  sessionId: string;
}

/** `LoggerImpl::Observer`. */
export type LogObserver = (entry: LogEntry) => void;

/** `kEntriesCapacity`. */
const ENTRIES_CAPACITY = 1000;
/** `kComponentMaxLength`. */
const COMPONENT_MAX_LENGTH = 64;
/** `kMessageMaxLength`. */
const MESSAGE_MAX_LENGTH = 1024;
/** `kSourceMaxLength`. */
const SOURCE_MAX_LENGTH = 64;
/** `log_util::TruncateId`: ids are cut to 9 characters. */
const ID_MAX_LENGTH = 9;

/** `MediaSource::TruncateForLogging`: the origin of a URL source, else the id up to its query. */
function truncateSource(source: string, maxLength: number): string {
  let origin = "";
  try {
    const url = new URL(source);
    if (url.origin !== "null") origin = `${url.origin}/`;
  } catch {
    // not a URL: an id such as `urn:x-org.chromium.media:source:tab:3`
  }
  if (origin !== "") return origin.slice(0, maxLength);
  const query = source.indexOf("?");
  return source.slice(0, query === -1 ? maxLength : query);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `base::TimeFormatTimeOfDayWithMilliseconds`. */
function timeOfDay(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** `LoggerImpl`. */
export class MediaRouterLogger {
  private entries: LogEntry[] = [];
  private readonly observers = new Set<LogObserver>();

  /** `LoggerImpl::LogInfo`, `LogWarning` and `LogError`: the severity picks the method. */
  info(category: LogCategory, component: string, message: string, ids: { sinkId?: string; mediaSource?: string; sessionId?: string } = {}): void {
    this.log("Info", category, new Date(), component, message, ids.sinkId ?? "", ids.mediaSource ?? "", ids.sessionId ?? "");
  }

  warning(category: LogCategory, component: string, message: string, ids: { sinkId?: string; mediaSource?: string; sessionId?: string } = {}): void {
    this.log("Warning", category, new Date(), component, message, ids.sinkId ?? "", ids.mediaSource ?? "", ids.sessionId ?? "");
  }

  error(category: LogCategory, component: string, message: string, ids: { sinkId?: string; mediaSource?: string; sessionId?: string } = {}): void {
    this.log("Error", category, new Date(), component, message, ids.sinkId ?? "", ids.mediaSource ?? "", ids.sessionId ?? "");
  }

  /** `LoggerImpl::Log`: appends, drops the oldest entry past 1000, and tells the observers. */
  log(
    severity: LogSeverity, category: LogCategory, time: Date, component: string, message: string,
    sinkId: string, mediaSource: string, sessionId: string,
  ): void {
    const entry: LogEntry = {
      severity,
      category,
      time: timeOfDay(time),
      component: component.slice(0, COMPONENT_MAX_LENGTH),
      message: message.slice(0, MESSAGE_MAX_LENGTH),
      sinkId: sinkId.slice(0, ID_MAX_LENGTH),
      mediaSource: truncateSource(mediaSource, SOURCE_MAX_LENGTH),
      sessionId: sessionId.slice(0, ID_MAX_LENGTH),
    };
    this.entries.push(entry);
    if (this.entries.length > ENTRIES_CAPACITY) this.entries.shift();
    for (const observer of [...this.observers]) {
      try {
        observer({ ...entry });
      } catch (err) {
        console.error("electron-cast: a log observer failed", err);
      }
    }
  }

  /** `LoggerImpl::GetLogsAsValue`: the entries, oldest first. */
  getLogs(): LogEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** `LoggerImpl::GetLogsAsJson`. */
  getLogsAsJson(): string {
    return JSON.stringify(this.entries, null, 3);
  }

  /** `LoggerImpl::AddObserver`. Returns the `RemoveObserver` function. */
  addObserver(observer: LogObserver): () => void {
    this.observers.add(observer);
    return () => void this.observers.delete(observer);
  }

  dispose(): void {
    this.observers.clear();
    this.entries = [];
  }
}
