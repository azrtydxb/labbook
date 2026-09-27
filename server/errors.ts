export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'authentication required') => new HttpError(401, msg);
export const forbidden = (msg = 'forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'not found') => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
