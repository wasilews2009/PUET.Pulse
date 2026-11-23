import { Inject, Injectable } from '@nestjs/common';
import { generators, Issuer, type BaseClient } from 'openid-client';
import { APP_CONFIG, type AppConfig } from '../config/config';

export const OIDC_PROVIDER = Symbol('OIDC_PROVIDER');

export interface IdTokenClaims {
  sub: string;
  email?: string;
  acr?: string;
  amr?: string[];
  [claim: string]: unknown;
}

/**
 * Thin seam over openid-client (certified OpenID RP library): discovery, PKCE,
 * state, nonce and ID token signature / iss / aud / exp / nonce validation are
 * all done by the library. Tests replace it with a fake.
 */
export interface OidcProvider {
  authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; acr?: string }): Promise<string>;
  exchange(p: {
    params: Record<string, string>;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<IdTokenClaims>;
  endSessionUrl(): Promise<string | undefined>;
}

export const oidcGenerators = {
  state: () => generators.state(),
  nonce: () => generators.nonce(),
  codeVerifier: () => generators.codeVerifier(),
  codeChallenge: (verifier: string) => generators.codeChallenge(verifier),
};

@Injectable()
export class OpenIdClientProvider implements OidcProvider {
  private client?: Promise<BaseClient>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private getClient(): Promise<BaseClient> {
    this.client ??= Issuer.discover(this.config.oidc.issuerUrl).then(
      (issuer) =>
        new issuer.Client({
          client_id: this.config.oidc.clientId,
          client_secret: this.config.oidc.clientSecret,
          redirect_uris: [this.config.oidc.redirectUri],
          response_types: ['code'],
        }),
    );
    // Allow a retry if discovery failed (IdP temporarily down).
    this.client.catch(() => (this.client = undefined));
    return this.client;
  }

  async authorizationUrl(p: { state: string; nonce: string; codeChallenge: string; acr?: string }): Promise<string> {
    const client = await this.getClient();
    return client.authorizationUrl({
      scope: 'openid profile email',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ...(p.acr ? { acr_values: p.acr, prompt: 'login' } : {}),
    });
  }

  async exchange(p: {
    params: Record<string, string>;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<IdTokenClaims> {
    const client = await this.getClient();
    const tokens = await client.callback(this.config.oidc.redirectUri, p.params, {
      state: p.state,
      nonce: p.nonce,
      code_verifier: p.codeVerifier,
    });
    return tokens.claims() as IdTokenClaims;
  }

  async endSessionUrl(): Promise<string | undefined> {
    const client = await this.getClient();
    if (!client.issuer.metadata.end_session_endpoint) return undefined;
    return client.endSessionUrl({
      client_id: this.config.oidc.clientId,
      ...(this.config.oidc.postLogoutRedirectUri
        ? { post_logout_redirect_uri: this.config.oidc.postLogoutRedirectUri }
        : {}),
    });
  }
}
