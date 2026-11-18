/** Typed service error: routes map `code` to the HTTP status and pass
 *  `message` through — services never touch Fastify. */
export class ServiceError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
