// A public HLS sample (Shaka Player's demo assets, served with the CORS headers a Cast receiver needs).
const SAMPLE_URL = "https://storage.googleapis.com/shaka-demo-assets/bbb-dark-truths-hls/hls.m3u8";
const status = document.getElementById("status");
const play = document.getElementById("play");

window.__onGCastApiAvailable = (available) => {
  if (!available) {
    status.textContent = "The Cast SDK is not available.";
    return;
  }
  const context = cast.framework.CastContext.getInstance();
  context.setOptions({
    // The default media receiver.
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  status.textContent = "Click the Cast button to pick a device.";

  context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
    const connected =
      event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
      event.sessionState === cast.framework.SessionState.SESSION_RESUMED;
    play.disabled = !connected;
    status.textContent = `Session: ${event.sessionState}`;
  });

  // Only starting the session needs a user gesture (the launcher click); loading media does not.
  play.addEventListener("click", async () => {
    const session = context.getCurrentSession();
    if (!session) return;
    const mediaInfo = new chrome.cast.media.MediaInfo(SAMPLE_URL, "application/x-mpegURL");
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = "Big Buck Bunny";
    const error = await session.loadMedia(new chrome.cast.media.LoadRequest(mediaInfo));
    status.textContent = error ? `Load failed: ${error}` : "Playing on the device.";
  });
};

// Wired displays: present receiver.html on another screen (needs a second display). start() needs the click.
const presentButton = document.getElementById("present");
const presentStatus = document.getElementById("present-status");
const request = new PresentationRequest([`${location.origin}/receiver.html`]);
let presented = null;

request.getAvailability().then((availability) => {
  const update = () => { presentButton.disabled = !availability.value; };
  availability.addEventListener("change", update);
  update();
});

presentButton.addEventListener("click", async () => {
  try {
    presented = await request.start();
    presentStatus.textContent = `Presenting (${presented.state})`;
    presented.addEventListener("connect", () => { presentStatus.textContent = "Receiver connected"; presented.send("hello"); });
    presented.addEventListener("message", (event) => { presentStatus.textContent = `Receiver said: ${event.data}`; });
    presented.addEventListener("terminate", () => { presentStatus.textContent = "Presentation ended"; });
  } catch (error) {
    presentStatus.textContent = `Not presented: ${error.name}`;
  }
});
