import { createHash, createSign, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { JsonFile } from "../store.js";

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Anything that can produce a Google API access token. */
export interface TokenSource {
  accessToken(): Promise<string>;
}

/** The fields we use from a service-account key file downloaded from Google Cloud. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

/**
 * Google service account: a robot identity with its own email. No browser sign-in and nothing
 * that expires; it sees only the Drive folders that were shared with its email.
 */
export class ServiceAccountAuth implements TokenSource {
  private token?: { value: string; expiresAt: number };
  private refreshing?: Promise<string>;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scopes: string[],
  ) {
    if (!key.client_email || !key.private_key?.includes("PRIVATE KEY")) {
      throw new Error('Not a service-account key file: it must contain "client_email" and "private_key"');
    }
  }

  get email(): string {
    return this.key.client_email;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    this.refreshing ??= this.request().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Signs a short-lived JWT with the account's private key and trades it for an access token. */
  private async request(): Promise<string> {
    const tokenUrl = this.key.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: this.key.private_key_id })}.${encode({
      iss: this.key.client_email,
      scope: this.scopes.join(" "),
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key, "base64url");

    const response = await fetch(tokenUrl, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(`Google service-account token request failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim());
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Where the refresh token is kept. Treat as a secret. */
  tokenFile: string;
  authUrl?: string;
  tokenUrl?: string;
}

interface StoredToken {
  refreshToken?: string;
  accessToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

/**
 * Google OAuth 2.0 for an installed app: a one-time browser sign-in stores a refresh token,
 * after which access tokens are renewed without anyone present.
 */
export class GoogleAuth implements TokenSource {
  private readonly file: JsonFile<StoredToken>;
  private readonly authUrl: string;
  private readonly tokenUrl: string;
  private loaded = false;
  private refreshing?: Promise<string>;

  constructor(private readonly options: GoogleAuthOptions) {
    this.file = new JsonFile<StoredToken>(options.tokenFile, {});
    this.authUrl = options.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
    this.tokenUrl = options.tokenUrl ?? "https://oauth2.googleapis.com/token";
  }

  /** True once someone has signed in (a refresh token is on disk). */
  async isSignedIn(): Promise<boolean> {
    return Boolean((await this.token()).refreshToken);
  }

  /** A valid access token, renewed when it has less than a minute left. */
  async accessToken(): Promise<string> {
    const token = await this.token();
    if (token.accessToken && (token.expiresAt ?? 0) > Date.now() + 60_000) return token.accessToken;
    if (!token.refreshToken) throw new Error("Not signed in to Google; run: npm run google-login");
    // Concurrent callers share one refresh.
    this.refreshing ??= this.exchange({ grant_type: "refresh_token", refresh_token: token.refreshToken }).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Interactive sign-in. Listens on a loopback port, hands the consent URL to `onUrl` (print it,
   * open a browser), and resolves once Google redirects back and the code has been exchanged.
   */
  async login(scopes: string[], onUrl: (url: string) => void, timeoutMs = 5 * 60_000): Promise<void> {
    // PKCE and `state` tie the redirect to this sign-in attempt.
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");

    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = "";
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== "/") return void response.writeHead(404).end();
        const error = url.searchParams.get("error");
        const received = url.searchParams.get("code");
        const valid = !error && received && url.searchParams.get("state") === state;
        response
          .writeHead(valid ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
          .end(`<h3>${valid ? "Đăng nhập Google thành công. Bạn có thể đóng trang này." : `Đăng nhập thất bại: ${error ?? "yêu cầu không hợp lệ"}`}</h3>`);
        clearTimeout(timer);
        server.close();
        if (valid) resolve({ code: received, redirectUri });
        else reject(new Error(`Google sign-in failed: ${error ?? "state mismatch"}`));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Timed out waiting for the Google sign-in to finish"));
      }, timeoutMs);
      server.on("error", reject);
      // Port 0: any free port. Desktop-type OAuth clients accept any loopback port.
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        redirectUri = `http://127.0.0.1:${port}`;
        const query = new URLSearchParams({
          client_id: this.options.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: scopes.join(" "),
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          // offline + consent: always return a refresh token, even on a repeat sign-in.
          access_type: "offline",
          prompt: "consent",
        });
        onUrl(`${this.authUrl}?${query}`);
      });
    });

    await this.exchange({ grant_type: "authorization_code", code: code.code, redirect_uri: code.redirectUri, code_verifier: verifier });
    if (!this.file.data.refreshToken) throw new Error("Google returned no refresh token; remove the app's access in your Google account and sign in again");
  }

  private async token(): Promise<StoredToken> {
    if (!this.loaded) {
      await this.file.load();
      this.loaded = true;
    }
    return this.file.data;
  }

  private async exchange(params: Record<string, string>): Promise<string> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...params }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !body.access_token) {
      // invalid_grant: the refresh token was revoked or has expired (7 days for apps in "Testing").
      const hint = body.error === "invalid_grant" ? "; sign in again with: npm run google-login" : "";
      throw new Error(`Google token request failed: ${body.error ?? response.status} ${body.error_description ?? ""}${hint}`.trim());
    }
    const token = await this.token();
    token.accessToken = body.access_token;
    token.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    if (body.refresh_token) token.refreshToken = body.refresh_token;
    await this.file.save();
    return body.access_token;
  }
}
