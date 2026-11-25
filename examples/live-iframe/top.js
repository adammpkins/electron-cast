// The top page: hosts the two iframes, lets a person remove / navigate them, and shows each frame's own report next to
// the main process's view. It does not cast itself.
const cross = new URLSearchParams(location.search).get("cross");
const FRAMES = {
  same: { base: location.origin, nav: 0, el: null, last: null },
  cross: { base: cross, nav: 0, el: null, last: null },
};
const $ = (id) => document.getElementById(id);
$("origin").textContent = `(top page origin ${location.origin})`;

function mount(name) {
  const f = FRAMES[name];
  f.last = null;
  const slot = document.createElement("div");
  slot.style.flex = "1";
  slot.id = `slot-${name}`;
  const iframe = document.createElement("iframe");
  iframe.src = `${f.base}/frame.html?name=${name}&n=${f.nav}`;
  slot.append(iframe);
  f.el = iframe;
  const old = $(`slot-${name}`);
  if (old) old.replaceWith(slot);
  else $("frames").append(slot);
  render();
}
function unmount(name) {
  const f = FRAMES[name];
  const gone = document.createElement("div");
  gone.className = "gone";
  gone.id = `slot-${name}`;
  gone.textContent = `${name} iframe removed from the DOM`;
  $(`slot-${name}`).replaceWith(gone);
  f.el = null;
  render();
}
for (const name of Object.keys(FRAMES)) {
  $(`add-${name}`).onclick = () => { if (!FRAMES[name].el) mount(name); };
  $(`rm-${name}`).onclick = () => { if (FRAMES[name].el) unmount(name); };
  // Same origin, new URL: the iframe navigates (its document is replaced) while its frame stays
  $(`nav-${name}`).onclick = () => {
    const f = FRAMES[name];
    if (!f.el) return;
    f.nav++;
    f.el.src = `${f.base}/frame.html?name=${name}&n=${f.nav}`;
  };
}
$("reload").onclick = () => location.reload();

window.addEventListener("message", (e) => {
  if (!e.data || e.data.live !== "state") return;
  for (const [name, f] of Object.entries(FRAMES)) {
    if (f.el && e.source === f.el.contentWindow) f.last = { ...e.data.state, seenOrigin: e.origin };
  }
  render();
});

function render() {
  $("rows").replaceChildren(
    ...Object.entries(FRAMES).map(([name, f]) => {
      const s = f.last;
      const tr = document.createElement("tr");
      const cells = [
        name,
        f.el ? "yes" : "no (removed)",
        s ? s.seenOrigin : "-",
        s ? s.instance : "-",
        s ? s.castState : "-",
        s ? s.sessionState : "-",
        s ? s.sessionId : "-",
        s ? s.events : "-",
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.append(td);
      }
      return tr;
    }),
  );
}

// Called by the main process (it runs a snippet in this page) with what the manager sees
window.liveMain = (kind, data) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${kind} ${JSON.stringify(data)}\n`;
  $("main").textContent += line;
  $("main").scrollTop = $("main").scrollHeight;
};

mount("same");
mount("cross");
