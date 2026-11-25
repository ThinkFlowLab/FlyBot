# Third-party login (Google, GitHub, generic OIDC)

Self-written for FlyBot; no FlyBot, Bot Social, DS-Bot or Teamily source. This is standard OAuth/OIDC for a self-hosted management server, not a Teamily identity comparison.

The operator enables providers with `--oidc-providers`, a private JSON file containing `client_id` and `client_secret`. Secrets are never written to the repository, API responses or request logs. Disabled providers are omitted from the public list and cannot be started. Password registration and login keep working.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/auth/providers` | `{items:[{id,type,label}]}` for enabled providers only. Unauthenticated |
| POST | `/v1/auth/oidc/start` | `{provider}`. Exact Origin required. Returns `{authorization_url}`. PKCE S256, unguessable `state`, and (except GitHub) a `nonce` are stored server-side, wrapped, one-time, 10 minutes |
| GET | `/v1/auth/oidc/callback` | Provider redirect with `code` and `state`. Verifies token/signature/audience/issuer/nonce/expiry and a **verified** email. Sets the session cookie and returns `302` `/` |
| POST | `/v1/auth/oidc/link` | `{token}` when already signed in (CSRF + Origin), or `{token,username,password}` to confirm. Required when a verified email already belongs to an account and the caller was not signed in |

`redirect_uri` is always `{origin}/v1/auth/oidc/callback`. Authorization Code + PKCE only. Google and generic OIDC use an ID token (RS256, JWKS). GitHub uses the emails API and requires a primary verified address. New accounts get a unique username derived from the email local part and a random, unusable password so only the linked provider (or a later password set) can sign in.

Linking uses the verified email, never an unverified address. The same `(provider, subject)` always returns the same user. The raw authorization code, tokens and client secret are not stored.

## Operator file

```json
{"providers":[
  {"id":"google","type":"google","client_id":"...","client_secret":"...","enabled":true},
  {"id":"github","type":"github","client_id":"...","client_secret":"...","enabled":true},
  {"id":"work","type":"oidc","label":"Work","issuer":"https://idp.example","client_id":"...","client_secret":"...","authorization_endpoint":"https://idp.example/auth","token_endpoint":"https://idp.example/token","jwks_uri":"https://idp.example/jwks","enabled":true}
]}
```

The file must be mode 0600, owned by the process user, and must not use symbolic links. Reloading requires a restart. To use Google or GitHub in production the operator creates an OAuth app at that vendor and copies the client id and secret here.

## Tests

Automated tests use an in-process fake provider and a locally generated RSA key. CI does not contain real Google or GitHub credentials and does not make network calls to those vendors.

## Not in this slice

No social login button theming copied from vendors beyond the provider label, no account recovery, no “set a password” form yet, no SCIM. Browser E2E against a real Google project is not claimed.
