// The presentation page: shown fullscreen on the chosen display. It answers every message with "echo: <message>".
const out = document.getElementById("out");

function attach(connection) {
  out.textContent = `Connected (${connection.id})`;
  connection.addEventListener("message", (event) => {
    out.textContent = `Received: ${event.data}`;
    connection.send(`echo: ${event.data}`);
  });
  connection.addEventListener("close", () => {
    out.textContent = "The controller disconnected";
  });
}

navigator.presentation.receiver.connectionList.then((list) => {
  list.connections.forEach(attach);
  list.addEventListener("connectionavailable", (event) => attach(event.connection));
});
