/** Well-known Cast v2 namespace urns. */
export const NS = {
  CONNECTION: "urn:x-cast:com.google.cast.tp.connection",
  HEARTBEAT: "urn:x-cast:com.google.cast.tp.heartbeat",
  RECEIVER: "urn:x-cast:com.google.cast.receiver",
  DEVICE_AUTH: "urn:x-cast:com.google.cast.tp.deviceauth",
} as const;

/** Destination id of the platform receiver (the device itself). */
export const PLATFORM_RECEIVER_ID = "receiver-0";
