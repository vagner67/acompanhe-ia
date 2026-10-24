/** Tipos locais do front (não são DTO de API — DTOs vivem em @acompanhe/shared). */
export interface Session {
  token: string;
  expiresInSec: number;
  user: { id: number; firstName: string };
}
