import { connect } from "node:net";

const url = process.argv[2];

if (!url) {
  throw new Error("Usage: node inspect-remote-document.mjs <url>");
}

function httpJson(path) {
  return fetch(`http://127.0.0.1:9223${path}`).then(async (response) => {
    if (!response.ok) throw new Error(`Chrome DevTools ${path}: ${response.status}`);
    return response.json();
  });
}

function wsFrame(payload) {
  const value = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(value.length < 126 ? 6 : 8);
  header[0] = 0x81;
  header[1] = 0x80 | (value.length < 126 ? value.length : 126);
  if (value.length >= 126) header.writeUInt16BE(value.length, 2);
  const mask = Buffer.from([12, 43, 71, 19]);
  mask.copy(header, header.length - 4);
  for (let index = 0; index < value.length; index += 1) value[index] ^= mask[index % 4];
  return Buffer.concat([header, value]);
}

function connectCdp(wsUrl) {
  const match = wsUrl.match(/^ws:\/\/([^/:]+):(\d+)(\/.*)$/);
  if (!match) throw new Error(`Unsupported DevTools URL: ${wsUrl}`);
  const [, host, port, path] = match;
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), host);
    const key = Buffer.from("stockhub-hydration-inspector").toString("base64");
    let handshake = true;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    const events = [];
    let nextId = 1;

    socket.on("error", reject);
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (handshake) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!buffer.subarray(0, end).toString().includes("101")) return reject(new Error("DevTools WebSocket upgrade failed"));
        buffer = buffer.subarray(end + 4);
        handshake = false;
        resolve({
          close: () => socket.end(),
          events,
          send(method, params = {}) {
            const id = nextId++;
            socket.write(wsFrame({ id, method, params }));
            return new Promise((resolveMessage, rejectMessage) => pending.set(id, { resolve: resolveMessage, reject: rejectMessage }));
          },
        });
      }
      while (!handshake && buffer.length >= 2) {
        const length = buffer[1] & 0x7f;
        const headerSize = length === 126 ? 4 : 2;
        const payloadLength = length === 126 ? buffer.readUInt16BE(2) : length;
        if (buffer.length < headerSize + payloadLength) return;
        const payload = buffer.subarray(headerSize, headerSize + payloadLength).toString();
        buffer = buffer.subarray(headerSize + payloadLength);
        const message = JSON.parse(payload);
        if (message.id) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(message.error); else request?.resolve(message.result);
        } else events.push(message);
      }
    });
  });
}

const pages = await httpJson("/json");
const page = pages.find((candidate) => candidate.type === "page") ?? pages[0];
const cdp = await connectCdp(page.webSocketDebuggerUrl);
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__stockhubDocumentEvents=[];new MutationObserver((records)=>{for(const record of records){for(const [type,nodes] of [['add',record.addedNodes],['remove',record.removedNodes]]){for(const node of nodes){if(node.nodeType===1&&['HEAD','BODY','LINK','STYLE','SCRIPT'].includes(node.tagName)){window.__stockhubDocumentEvents.push({type,tag:node.tagName,parent:node.parentElement?.tagName||record.target?.tagName,rel:node.rel||null,href:node.href||null});}}}}}).observe(document,{childList:true,subtree:true});`,
  });
  await cdp.send("Page.navigate", { url });
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const result = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({url:location.href,readyState:document.readyState,children:[...document.documentElement.children].map(node=>node.tagName),links:[...document.querySelectorAll('link')].map(node=>({rel:node.rel,href:node.href,parent:node.parentElement?.tagName})),events:window.__stockhubDocumentEvents,htmlPrefix:document.documentElement.outerHTML.slice(0,1000)})`,
    returnByValue: true,
  });
  const browserErrors = cdp.events
    .filter((event) => event.method === "Log.entryAdded" && event.params.entry.level === "error")
    .map((event) => event.params.entry.text);
  const reactConsoleErrors = cdp.events
    .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
    .map((event) => event.params.args.map((argument) => argument.value ?? argument.description).join(" "));
  console.log(JSON.stringify({ document: JSON.parse(result.result.value), consoleErrors: [...browserErrors, ...reactConsoleErrors] }, null, 2));
} finally {
  cdp.close();
}
