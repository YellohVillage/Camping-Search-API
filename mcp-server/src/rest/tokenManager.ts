/**
 * Token de session de l'API REST, gardé en mémoire d'instance (§9.2) : obtenu avec la clé d'API,
 * renouvelé `renewBeforeSeconds` avant son expiration, ou à la demande après un 401.
 */
export interface TokenSource {
  /** Demande un nouveau token (POST /v1/auth/session). */
  fetchToken(): Promise<{ token: string; expiresAt: Date }>;
}

export class TokenManager {
  private current?: { token: string; expiresAt: Date };
  private pending?: Promise<string>;

  constructor(
    private readonly source: TokenSource,
    private readonly renewBeforeSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Token valide, renouvelé si nécessaire (les demandes simultanées partagent le même renouvellement). */
  async getToken(): Promise<string> {
    const c = this.current;
    if (c && c.expiresAt.getTime() - this.renewBeforeSeconds * 1000 > this.now().getTime()) return c.token;
    if (!this.pending) {
      this.pending = this.source
        .fetchToken()
        .then((t) => {
          this.current = t;
          return t.token;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  /** Oublie le token courant (après un 401). */
  invalidate(): void {
    this.current = undefined;
  }
}
