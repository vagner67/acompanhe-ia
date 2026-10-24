import { SignJWT, jwtVerify } from "jose";

/**
 * JWT da Mini App (doc 02 §3): TTL 1 h · chave SEPARADA do bot token · rotacionar por incidente.
 */
export interface SessionClaims {
  sub: string; // tg_user_id
  username?: string;
  kind: "session";
}

export class JwtService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(tgUserId: number | string, username?: string): Promise<string> {
    return new SignJWT({ kind: "session", ...(username ? { username } : {}) })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(tgUserId))
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<SessionClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"] });
      if (payload.kind !== "session" || typeof payload.sub !== "string") return null;
      return {
        sub: payload.sub,
        kind: "session",
        ...(typeof payload.username === "string" ? { username: payload.username } : {}),
      };
    } catch {
      return null; // token inválido/expirado nunca derruba o processo
    }
  }
}
