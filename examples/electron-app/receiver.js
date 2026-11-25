// The presentation page: shown fullscreen on the chosen display. It answers every text message with "echo: <message>" and sends bytes back as they came.
const out = document.getElementById("out");

function attach(connection) {
  out.textContent = `Connected (${connection.id})`;
  connection.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      out.textContent = `Received: ${event.data}`;
      connection.send(`echo: ${event.data}`);
    } else {
      // Binary arrives as an ArrayBuffer (connection.binaryType) and goes back the same way
      out.textContent = `Received ${event.data.byteLength} bytes`;
      connection.send(event.data);
    }
  });
  connection.addEventListener("close", () => {
    out.textContent = "The controller disconnected";
  });
}

navigator.presentation.receiver.connectionList.then((list) => {
  list.connections.forEach(attach);
  list.addEventListener("connectionavailable", (event) => attach(event.connection));
});
