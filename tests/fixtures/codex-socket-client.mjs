import WebSocket from 'ws';
import { createInterface } from 'node:readline';
const ws = new WebSocket('ws+unix://' + process.argv[2] + ':/');
const pending = [];
ws.on('open', () => {
  for (const text of pending) ws.send(text);
  pending.length = 0;
});
ws.on('message', (data) => console.log(data.toString()));
ws.on('close', () => process.exit(0));
ws.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
createInterface({ input: process.stdin }).on('line', (text) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(text);
  else pending.push(text);
});
