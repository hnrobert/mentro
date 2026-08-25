import type { WebSocket } from "ws";

type Client = WebSocket;

const clients = new Set<Client>();

export function addClient(ws: Client): void {
  clients.add(ws);
}

export function removeClient(ws: Client): void {
  clients.delete(ws);
}

export function publish(event: Record<string, unknown>): void {
  const text = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

export function clientCount(): number {
  return clients.size;
}
