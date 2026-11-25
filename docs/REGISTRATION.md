# Local account registration

`/register` is a same-origin account creation form for the existing
`POST /v1/auth/register` API. It does not enable registration: the operator must
explicitly start the development server with `--open-registration`. A closed
instance returns its existing `registration_closed` error. Origin validation,
rate limits, account capacity, password hashing, secure session cookies and
subsequent session CSRF checks are unchanged.

The form posts JSON, clears the password after the attempt and, only after HTTP
201 AND a matching authenticated GET `/v1/auth/session`, opens `/`. Credentials are not placed in query strings,
local storage, console logs or error messages. It requires JavaScript; scripts
and styles are same-origin external assets under the existing strict CSP.

The login forms link to `/register`. `GET /v1/auth/policy` reports only registration
policy and field/TLS requirements, never user counts or a first-user/admin bootstrap
condition. A closed instance explains the policy and still returns the original
403 on submission. Public registration remains disabled by default. No first
registrant gets operator rights; the independent operator configuration is unchanged.
The first home load awaits personal-agent initialization before listing workspaces
and accepts its real 201 response, avoiding an empty first-use workspace race.

## Nonsecret deployment checks
- Operator explicitly sets `--open-registration` if public signup is intended.
- Exact `--origin https://your.public.host`, lowercase, no trailing slash or path.
- Reverse proxy preserves original public `Host`; page and API use the same HTTPS
  origin. Untrusted forwarded headers are intentionally not accepted as identity.
- Do NOT use `--insecure-local` publicly. Secure `__Host-ot_session` and readable
  `__Host-ot_csrf` have Path=/, SameSite=Strict, no Domain; session is HttpOnly.
- An HTTP201 with missing/blocked session cookie is reported as account-created
  but session-unconfirmed, not a successful login or failed account creation.
- Registration policy is configuration. Missing form/entry/session verification
  and the first-workspace sequencing are separate product fixes. Do not diagnose
  a live proxy or override a closed policy just from the source.

For isolated loopback testing only, the server can use `--insecure-local`.
That option is not suitable for a public deployment. Registration does not
configure a model, a Composio key or a runtime, and proves no vendor connectivity.
