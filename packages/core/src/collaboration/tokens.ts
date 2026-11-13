import { randomUUID } from 'node:crypto';

/**
 * Per-session collaboration tokens (D14, ADR 0016). Issued when core creates
 * an adapter session and revoked when it is disposed; kept in memory only —
 * a token never touches the database, the logs or a diagnostic export.
 */
export class SessionTokens {
  private readonly conversationByToken = new Map<string, string>();

  issue(conversationId: string): string {
    const token = randomUUID();
    this.conversationByToken.set(token, conversationId);
    return token;
  }

  resolve(token: string): string | null {
    return this.conversationByToken.get(token) ?? null;
  }

  revoke(token: string): void {
    this.conversationByToken.delete(token);
  }

  /** Safety net for paths that dispose sessions without their token at hand. */
  revokeConversation(conversationId: string): void {
    for (const [token, id] of this.conversationByToken) {
      if (id === conversationId) this.conversationByToken.delete(token);
    }
  }
}
