import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "./auth/tokens";
import { addClient, removeClient } from "./bus";

export function registerWs(
  app: FastifyInstance,
  deps: { jwtSecret: Uint8Array },
) {
  app.get("/api/ws", { websocket: true }, async (socket, request) => {
    const token = (request.query as Record<string, string | undefined>).token;
    const user = token ? await verifyAccessToken(token, deps.jwtSecret) : null;
    if (!user) {
      socket.close(4401, "unauthorized");
      return;
    }
    addClient(socket);
    socket.on("close", () => removeClient(socket));
  });
}
