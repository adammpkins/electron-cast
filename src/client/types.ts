/** An application running on the receiver, as reported in RECEIVER_STATUS. */
export interface ReceiverApplication {
  appId: string;
  displayName: string;
  sessionId: string;
  transportId: string;
  statusText?: string;
  namespaces: { name: string }[];
  isIdleScreen?: boolean;
  iconUrl?: string;
  [key: string]: unknown;
}

/** Volume state of the receiver. */
export interface ReceiverVolume {
  level?: number;
  muted?: boolean;
  controlType?: string;
  stepInterval?: number;
}

/** Normalized receiver status (the `status` field of RECEIVER_STATUS). */
export interface ReceiverStatus {
  applications: ReceiverApplication[];
  volume: ReceiverVolume;
  [key: string]: unknown;
}
