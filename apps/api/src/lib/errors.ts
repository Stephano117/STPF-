export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentification requise.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Action non autorisée.', code = 'FORBIDDEN') => new AppError(403, code, message);
// Une ressource inaccessible est indiscernable d'une ressource inexistante.
export const notFound = (message = 'Ressource introuvable.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, code, message, details);
export const tooMany = (retryAfterSeconds: number) =>
  new AppError(429, 'RATE_LIMITED', 'Trop de tentatives. Réessayez dans quelques instants.', { retryAfterSeconds });
