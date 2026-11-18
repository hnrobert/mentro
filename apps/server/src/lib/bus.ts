// Minimal WebSocket shape — avoids a lib→routes dependency.
interface WebSocket {
  send(data: string): void;
  readyState: number;
}

type Client = WebSocket;

const clients = new Set<Client>();
const indexListeners = new Set<() => void>();

export function addClient(ws: Client): void {
  clients.add(ws);
}

export function removeClient(ws: Client): void {
  clients.delete(ws);
}

export function publish(event: Record<string, unknown>): void {
  if (event.event === "index.changed") {
    for (const fn of indexListeners) fn();
  }
  const text = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(text);
  }
}

/** In-process index-invalidations (e.g. the embedding cache). */
export function onIndexChanged(fn: () => void): () => void {
  indexListeners.add(fn);
  return () => indexListeners.delete(fn);
}

export function clientCount(): number {
  return clients.size;
}
