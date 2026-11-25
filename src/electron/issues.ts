import { CastLaunchError } from "../client/errors.ts";
import type { MediaRouterLogger } from "./logger.ts";

/**
 * Chrome's issues: what the Cast dialog shows next to a device when something went wrong ("Failed to cast. Please try
 * again.", "Accept cast request on your <device>", ...). Ports `IssueManager`, `Issue` and `IssuesObserver`
 * (components/media_router/browser/issue_manager.cc, components/media_router/common/issue.cc), plus the places Chrome
 * raises an issue (`RouterIssues`).
 */

/** `IssueInfo::Severity`. */
export type IssueSeverity = "warning" | "notification";

/** `IssueInfo`. */
export interface IssueInfo {
  title: string;
  severity: IssueSeverity;
  /** Description message for the issue; empty when there is none. */
  message: string;
  /** The route the issue is about, or `""` when no route is associated with it. */
  routeId: string;
  /** The sink the issue is about, or `""` when no sink is associated with it. */
  sinkId: string;
}

/** `Issue`: an issue as the manager holds it, with the id it was given. */
export interface Issue {
  readonly id: number;
  readonly info: Readonly<IssueInfo>;
  /** `Issue::is_permission_rejected_issue`: the local discovery permission was refused. */
  readonly isPermissionRejectedIssue: boolean;
}

/**
 * `IssuesObserver`. Like Chrome's, it hears of the top issue (the oldest one that is still up), not of every issue: a new
 * `onIssue` is a new top issue, and `onIssuesCleared` means none is left. Both are optional, as Chrome's have empty bodies.
 */
export interface IssuesObserver {
  onIssue?(issue: Issue): void;
  onIssuesCleared?(): void;
}

/** `IssueManager::GetAutoDismissTimeout`: the minutes a notification stays (`kNotificationAutoDismissMins`). */
const NOTIFICATION_AUTO_DISMISS_MS = 60_000;
/** `kWarningAutoDismissMins`. */
const WARNING_AUTO_DISMISS_MS = 5 * 60_000;

/** `Issue::g_next_issue_id`: ids count up from 0 across the process, so they never repeat between managers. */
let nextIssueId = 0;

/** What `IssueInfo`'s constructor takes: `message` and `routeId` default to empty, as the struct's fields do. */
export type IssueInit = Pick<IssueInfo, "title" | "severity"> & Partial<Pick<IssueInfo, "message" | "routeId" | "sinkId">>;

function complete(init: IssueInit): IssueInfo {
  return { title: init.title, severity: init.severity, message: init.message ?? "", routeId: init.routeId ?? "", sinkId: init.sinkId ?? "" };
}

/** `IssueInfo::operator==`. */
function sameInfo(a: IssueInfo, b: IssueInfo): boolean {
  return a.title === b.title && a.severity === b.severity && a.message === b.message && a.routeId === b.routeId && a.sinkId === b.sinkId;
}

/** `IssueManager`. */
export class IssueManager {
  /** `issues_map_`, a `flat_map` sorted by id: ids only grow, so insertion order is that order. */
  private readonly issues = new Map<number, Issue>();
  private readonly observers = new Set<IssuesObserver>();
  private readonly timers = new Map<number, NodeJS.Timeout>();
  /** `top_issue_id_`. */
  private topIssueId: number | undefined;

  /** `IssueManager::GetAutoDismissTimeout`. */
  static autoDismissTimeoutMs(info: Pick<IssueInfo, "severity">): number {
    return info.severity === "notification" ? NOTIFICATION_AUTO_DISMISS_MS : WARNING_AUTO_DISMISS_MS;
  }

  /** `IssueManager::AddIssue`: does nothing when an equal issue is already up. The issue goes away by itself after its timeout. */
  addIssue(init: IssueInit): void {
    const info = complete(init);
    for (const issue of this.issues.values()) if (sameInfo(issue.info, info)) return;
    const issue: Issue = { id: nextIssueId++, info, isPermissionRejectedIssue: false };
    // `PostDelayedTask(ClearIssue)`: a no-op once the issue was cleared
    const timer = setTimeout(() => this.clearIssue(issue.id), IssueManager.autoDismissTimeoutMs(info));
    timer.unref();
    this.timers.set(issue.id, timer);
    this.issues.set(issue.id, issue);
    this.maybeUpdateTopIssue();
  }

  /** `IssueManager::AddPermissionRejectedIssue`: replaces every issue (`issues_map_.clear()`), and has no timeout. */
  addPermissionRejectedIssue(): void {
    // `Issue(bool)` sets the severity to WARNING and nothing else
    const issue: Issue = {
      id: nextIssueId++,
      info: complete({ title: "", severity: "warning" }),
      isPermissionRejectedIssue: true,
    };
    this.dropAll();
    this.issues.set(issue.id, issue);
    this.maybeUpdateTopIssue();
  }

  /** `IssueManager::ClearIssue`. */
  clearIssue(issueId: number): void {
    if (this.issues.delete(issueId)) {
      this.cancelTimer(issueId);
      this.maybeUpdateTopIssue();
    }
  }

  /** `IssueManager::ClearAllIssues`. */
  clearAllIssues(): void {
    if (this.issues.size === 0) return;
    this.dropAll();
    this.maybeUpdateTopIssue();
  }

  /** `IssueManager::ClearTopIssueForSink`: clears the top issue only when it belongs to the sink. */
  clearTopIssueForSink(sinkId: string): void {
    const top = this.topIssueId === undefined ? undefined : this.issues.get(this.topIssueId);
    if (top !== undefined && top.info.sinkId === sinkId) this.clearIssue(top.id);
  }

  /**
   * `IssueManager::RegisterObserver`: the observer is told of the current top issue at once, if there is one. Returns the
   * `UnregisterObserver` function. Registering the same observer again does nothing (Chrome checks it with a DCHECK).
   */
  registerObserver(observer: IssuesObserver): () => void {
    if (!this.observers.has(observer)) {
      this.observers.add(observer);
      const top = this.topIssueId === undefined ? undefined : this.issues.get(this.topIssueId);
      if (top !== undefined) this.notifyOne(observer, (o) => o.onIssue?.(top));
    }
    return () => void this.observers.delete(observer);
  }

  /** The issues that are up now, oldest first (the first is the top issue). Not in Chrome, where a test reads `issues_map_`. */
  issuesNow(): Issue[] {
    return [...this.issues.values()];
  }

  /** Cancels the timers and forgets the observers. */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.issues.clear();
    this.observers.clear();
    this.topIssueId = undefined;
  }

  private dropAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.issues.clear();
  }

  private cancelTimer(issueId: number): void {
    const t = this.timers.get(issueId);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(issueId);
  }

  private notifyOne(observer: IssuesObserver, call: (o: IssuesObserver) => void): void {
    try {
      call(observer);
    } catch (err) {
      console.error("electron-cast: an issues observer failed", err);
    }
  }

  /** `IssueManager::MaybeUpdateTopIssue`, with its re-entrancy rules: an observer may add or clear issues from a callback. */
  private maybeUpdateTopIssue(): void {
    const first = this.issues.values().next();
    if (first.done === true) {
      // "If there was no top issue, observers have already been notified": no repeat
      if (this.topIssueId === undefined) return;
      this.topIssueId = undefined;
      for (const observer of [...this.observers]) {
        // a nested call raised an issue: stop telling the rest that none is left
        if (this.topIssueId !== undefined) break;
        this.notifyOne(observer, (o) => o.onIssuesCleared?.());
      }
      return;
    }
    const top = first.value;
    if (this.topIssueId === top.id) return;
    this.topIssueId = top.id;
    for (const observer of [...this.observers]) {
      // a nested call changed the top issue: the rest would get a stale one
      if (this.topIssueId !== top.id) break;
      this.notifyOne(observer, (o) => o.onIssue?.(top));
    }
  }
}

/**
 * Chrome's English titles (chrome/app/media_router_strings.grdp, `IDS_MEDIA_ROUTER_ISSUE_*`). The text is Chrome's
 * en-US one; electron-cast has no localization.
 */
export const ISSUE_TITLES = {
  /** `IDS_MEDIA_ROUTER_ISSUE_FAILED_TO_CAST` */
  failedToCast: "Failed to cast. Please try again.",
  /** `IDS_MEDIA_ROUTER_ISSUE_CANNOT_TERMINATE` */
  cannotTerminate: "Use remote to stop casting",
  /** `IDS_MEDIA_ROUTER_ISSUE_CREATE_ROUTE_TIMEOUT` */
  routeTimeout: "Unable to cast",
  /** `IDS_MEDIA_ROUTER_ISSUE_CREATE_ROUTE_TIMEOUT_FOR_DESKTOP` */
  routeTimeoutForDesktop: "Unable to cast screen.  Check to see if you confirmed the prompt to start sharing your screen.",
  /** `IDS_MEDIA_ROUTER_ISSUE_CREATE_ROUTE_TIMEOUT_FOR_TAB` */
  routeTimeoutForTab: "Unable to cast tab",
  /** `IDS_MEDIA_ROUTER_ISSUE_UNABLE_TO_CAST_DESKTOP` */
  unableToCastDesktop: "Unable to cast screen",
  /** `IDS_MEDIA_ROUTER_ISSUE_DESKTOP_AUDIO_NOT_SUPPORTED` */
  desktopAudioNotSupported: "Casting desktop audio is not supported on this device",
  /** `IDS_MEDIA_ROUTER_ISSUE_MAC_SCREEN_CAPTURE_PERMISSION_ERROR` */
  macScreenCapturePermission: "Unable to cast your screen. Check the Screen Recording permission in System Preferences.",
  routeTimeoutWithHostname: (hostName: string): string => `Unable to cast ${hostName}`,
  /** `IDS_MEDIA_ROUTER_ISSUE_CREATE_ROUTE_USER_PENDING_AUTHORIZATION`; Chrome's string has a leading space in the grdp, trimmed on load. */
  pendingAuthorization: (deviceName: string): string => `Accept cast request on your ${deviceName}`,
  /** `IDS_MEDIA_ROUTER_ISSUE_CREATE_ROUTE_USER_NOT_ALLOWED` */
  userNotAllowed: (deviceName: string): string => `Make sure to accept the cast request on your ${deviceName}`,
  /** `IDS_MEDIA_ROUTER_ISSUE_CREATE_ROUTE_NOTIFICATION_DISABLED` */
  notificationDisabled: (deviceName: string): string => `Make sure notifications are turned on on your ${deviceName}`,
} as const;

/** The cast modes the dialog's issues tell apart (`MediaCastMode`). */
export type IssueCastMode = "presentation" | "tab_mirror" | "desktop_mirror";

/**
 * How a Cast launch ended, as `CastActivityManager::HandleLaunchSessionResponse` tells them apart (the
 * `LaunchSessionResponse::Result` values that are failures).
 */
export type LaunchFailure = "user_not_allowed" | "notification_disabled" | "timed_out" | "error";

/**
 * `GetLaunchSessionResponse` (cast_message_util.cc): a `LAUNCH_ERROR` whose `extendedError` is `USER_NOT_ALLOWED` or
 * `USER_NOTIFICATIONS_DISABLED` is those results; any other error is `kError`. A launch that timed out is `kTimedOut`
 * (`CastMessageHandler::PendingRequests::LaunchSessionTimedOut`).
 */
export function classifyLaunchFailure(err: unknown): LaunchFailure {
  if (err instanceof Error && err.name === "CastTimeoutError") return "timed_out";
  // The channel has already read the `extendedError` (`launchErrorOf`); that is the one place it is told apart
  if (err instanceof CastLaunchError) return err.failure;
  const response = (err as { response?: unknown } | null | undefined)?.response;
  const extended = response !== null && typeof response === "object" ? (response as { extendedError?: unknown }).extendedError : undefined;
  if (extended === "USER_NOT_ALLOWED") return "user_not_allowed";
  if (extended === "USER_NOTIFICATIONS_DISABLED") return "notification_disabled";
  return "error";
}

/** `MediaRouteStarter::GetPresentationRequestSourceName`: `FormatUrlForSecurityDisplay` of the origin with http and https omitted. */
export function originNameForDisplay(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host;
    return url.origin === "null" ? origin : `${url.protocol}//${url.host}`;
  } catch {
    return origin;
  }
}

/** What the raising sites need to know about the sink an issue is for. */
export interface IssueSink {
  id: string;
  name: string;
}

export interface RouterIssuesOptions {
  /** `kShowCastPermissionRejectedError` (`--disable-features=ShowCastPermissionRejectedError` turns it off). Default true. */
  showPermissionRejectedError?: boolean;
  /** `BUILDFLAG(IS_MAC)`, which gates two of the issues. Default `process.platform === "darwin"`. */
  mac?: boolean;
  /** Where the launch's log lines go (`CastActivityManager`'s `logger_`). */
  logger?: MediaRouterLogger;
}

/**
 * The places Chrome raises an issue, one method each, with Chrome's title and severity. The methods named `ui*` are
 * `MediaRouterUI`'s (the dialog raises them when its route request answers); the others are the providers' and the
 * activity manager's (`media_router_->OnIssue`).
 */
export class RouterIssues {
  readonly manager: IssueManager;
  private readonly showPermissionRejected: boolean;
  private readonly mac: boolean;
  private readonly logger: MediaRouterLogger | undefined;

  constructor(manager: IssueManager, options: RouterIssuesOptions = {}) {
    this.manager = manager;
    this.showPermissionRejected = options.showPermissionRejectedError ?? true;
    this.mac = options.mac ?? process.platform === "darwin";
    this.logger = options.logger;
  }

  /** `CastActivityManager::SendFailedToCastIssue`. */
  failedToCast(sinkId: string, routeId: string): void {
    this.manager.addIssue({ title: ISSUE_TITLES.failedToCast, severity: "warning", sinkId, routeId });
  }

  /** `CastActivityManager::SendPendingUserAuthNotification`: the receiver waits for its user to accept the request. */
  pendingUserAuth(sink: IssueSink): void {
    this.logger?.info("Route", "CastActivityManager", "Pending user authentication for the cast request", { sinkId: sink.id });
    this.manager.addIssue({ title: ISSUE_TITLES.pendingAuthorization(sink.name), severity: "notification", sinkId: sink.id });
  }

  /** `kUserAllowed` of `HandleLaunchSessionResponse`: `ClearTopIssueForSink`. */
  userAllowed(sinkId: string): void {
    this.logger?.info("Route", "CastActivityManager", "The user accepted the cast request", { sinkId });
    this.manager.clearTopIssueForSink(sinkId);
  }

  /**
   * `HandleLaunchSessionResponse` and `HandleLaunchSessionResponseFailures` for a launch that failed: a declined
   * request clears the pending notice; every failure except a declined request and disabled notifications
   * (the receiver says why in those, and the dialog does) raises "Failed to cast".
   */
  launchFailed(failure: LaunchFailure, sinkId: string, routeId: string, errorMessage = ""): void {
    // the messages of HandleLaunchSessionResponse
    const message = failure === "user_not_allowed" ? "Failed to launch session as the user declined the cast request."
      : failure === "notification_disabled" ? "Failed to launch session as the notifications are disabled on the receiver device."
      : failure === "timed_out" ? "Failed to launch session due to timeout."
      : `Failed to launch session. ${errorMessage}`;
    this.logger?.error("Route", "CastActivityManager", message, { sinkId });
    if (failure === "user_not_allowed") this.manager.clearTopIssueForSink(sinkId);
    if (failure !== "user_not_allowed" && failure !== "notification_disabled") this.failedToCast(sinkId, routeId);
  }

  /** `DialMediaRouteProvider::HandleStopAppResult`: a stop that could not be confirmed. */
  cannotTerminate(sinkId: string): void {
    this.manager.addIssue({ title: ISSUE_TITLES.cannotTerminate, severity: "warning", sinkId });
  }

  /** `MediaRouterDesktop::OnLocalDiscoveryPermissionRejected`, behind `kShowCastPermissionRejectedError`. */
  localDiscoveryPermissionRejected(): void {
    if (this.showPermissionRejected) this.manager.addPermissionRejectedIssue();
  }

  /** `MediaRouterUI::CreateRoute` after its checks: `GetIssueManager()->ClearAllIssues()`. */
  routeRequested(): void {
    this.manager.clearAllIssues();
  }

  /** `MediaRouterUI::SendIssueForRouteTimeout`. `presentationSourceName` is the page's origin as `originNameForDisplay` gives it. */
  uiRouteTimeout(castMode: IssueCastMode, sinkId: string, presentationSourceName: string): void {
    const title = castMode === "presentation" ? ISSUE_TITLES.routeTimeoutWithHostname(presentationSourceName)
      : castMode === "tab_mirror" ? ISSUE_TITLES.routeTimeoutForTab
      : ISSUE_TITLES.routeTimeoutForDesktop;
    this.manager.addIssue({ title, severity: "notification", sinkId });
  }

  /** `MediaRouterUI::SendIssueForUserNotAllowed`. */
  uiUserNotAllowed(sink: IssueSink): void {
    this.manager.addIssue({ title: ISSUE_TITLES.userNotAllowed(sink.name), severity: "warning", sinkId: sink.id });
  }

  /** `MediaRouterUI::SendIssueForNotificationDisabled`. */
  uiNotificationDisabled(sink: IssueSink): void {
    this.manager.addIssue({ title: ISSUE_TITLES.notificationDisabled(sink.name), severity: "warning", sinkId: sink.id });
  }

  /**
   * `MediaRouterUI::SendIssueForUnableToCast`: "For a generic error, claim a tab error unless it was specifically desktop
   * mirroring." (Chrome uses the tab timeout string for it, whatever the cast mode.)
   */
  uiUnableToCast(castMode: IssueCastMode, sinkId: string): void {
    const title = castMode === "desktop_mirror" ? ISSUE_TITLES.unableToCastDesktop : ISSUE_TITLES.routeTimeoutForTab;
    this.manager.addIssue({ title, severity: "warning", sinkId });
  }

  /** `MediaRouterUI::SendIssueForScreenPermission`, which Chrome builds for macOS only. */
  uiScreenPermission(sinkId: string): void {
    if (!this.mac) return;
    this.manager.addIssue({ title: ISSUE_TITLES.macScreenCapturePermission, severity: "warning", sinkId });
  }

  /**
   * `CastActivityManager::MaybeShowIssueAtLaunch`: on macOS a desktop capture cannot carry its audio, and the
   * user is told.
   */
  desktopAudioNotSupportedAtLaunch(castMode: IssueCastMode, withAudio: boolean, sinkId: string): void {
    if (!this.mac || castMode !== "desktop_mirror" || withAudio) return;
    this.manager.addIssue({ title: ISSUE_TITLES.desktopAudioNotSupported, severity: "notification", sinkId });
  }
}
