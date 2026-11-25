# Exact HTTP model endpoints (operator opt-in; task transport only)

HTTPS remains the default. HTTP exposes both API credentials and prompts in
plaintext; this feature does not make an HTTP endpoint confidential or trusted.
Only a vetted, exact public **IPv4 literal + explicit port + base path** can be
opted in. DNS names, CIDRs, wildcards, IPv6/mapped forms, special-use ranges
(including multicast), credentials, query/fragment, encodings, dot segments,
noncanonical IP/port spellings and trailing slashes are rejected. Paths use
unreserved ASCII segments. Each call targets exactly `base + /chat/completions`.

The extra public-HTTP lane supports `openai`/`custom` OpenAI-compatible **agent
infer tasks**, including management skill/chat tasks. It does **not** enable the
native DSH model SDK: that SDK has no audited exact-destination/no-redirect
transport. The launcher validates the injected grant, does not export its key
or endpoint into the native SDK environment, and logs a nonsecret task-only
notice. Existing HTTPS model configuration/export is unchanged. Local/private
HTTP development is separate; model URLs no longer mistake reserved,
documentation or benchmark IPv4 addresses for ordinary private networks.
The shared management-origin `insecure_http_allowed` helper is unchanged.

## Configure locally

Create a private regular JSON file, owned by the Web process UID (file0600,
immediate directory0700). A disabled example is:

```json
{"version":1,"allowed_http_model_bases":[]}
```

Replace the empty list only with exact vetted endpoint bases. No real provider
address or credential is included in this example. Maximum16 unique entries.
The loader rejects duplicate/unknown fields, oversize files, hard links,
symlinks at any component, FIFOs and untrusted/writable ancestor directories;
a root-owned sticky ancestor such as `/tmp` is permitted. The policy contains
**no keys** and is never writable through a settings/API request.

For the loopback runner:

```sh
python -m flybot_workspace.server --data-dir /private/state \
  --origin https://management.example --model-http-policy /private/operator/model-http.json
```

For an operator's WSGI application, load with
`load_model_http_policy('/private/operator/model-http.json')` from
`flybot-workspace.model_http_policy`, then pass `model_http_policy=policy` to `App`.
The same App policy gates settings writes and both runtime credential APIs.
It is immutable and loaded at startup; reload/removal requires a Web restart.
Do not use a proxy, disable TLS, modify management origins, or add an API field
such as `allow_http` to work around the policy. Ordinary users cannot expand it.
Platform, account and workspace precedence stays unchanged: changing a URL in
an empty override cannot borrow or retarget a platform default credential.

## Upgrade all consumers together

The authenticated Python/JS task clients advertise
`X-FlyBot-Workspace-Model-HTTP: flybot-workspace.exact-http-task.v1`; JSON request schemas
remain unchanged. A client without this capability receives409 **before** a
public-HTTP key is returned or a one-time task grant is consumed. HTTPS does
not require the new capability. Old servers simply ignore the extra header.

Both task model-access and lease-gated runtime-secret issuance revalidate the
**current** policy against resolved settings, not only the settings-save path.
They derive `http_endpoint_grant={format,base_url}` from operator policy; it is
never accepted in settings, stored as user approval, or returned by public
configuration endpoints. Runtime/manager parsers reject missing/tampered grants.

Rebuild the pinned runtime image too. Its label
`io.flybot-workspace.model-http=flybot-workspace.exact-http-task.v1` identifies support.
Before materializing an HTTP secret, the manager inspects the exact registered
image digest and requires that label. New manager + old image fails closed
without writing the credential file. This is a capability assertion on an
operator-trusted pinned image, not third-party cryptographic attestation.

Python sends granted HTTP through a fresh urllib opener with inherited proxies
disabled and redirects refused. JS sends it through `node:http` with a
literal IPv4 destination, `agent:false`, bounded response and timeout: no DNS
name, inherited environment proxy, global fetch dispatcher, cookie jar or
redirect machinery. Its task-call options also require `redirect:'error'`.
All3xx responses, including same-origin redirects, fail closed without sending
a second request. Task result metadata omits credential/grant fields; provider
output remains untrusted.

A grant is protocol metadata from an authenticated trusted server, **not** a
signature, a sandbox against a compromised runtime, or proof of model prompt
contents. A runtime receiving a provider key necessarily can read that key.

## Revocation and rollback

Removing the endpoint blocks subsequent saves/credential issuance even for
preexisting configuration rows. A standalone `api_key:null` remains available
to clear an old key after policy removal. Existing authorizations already sent
to a runtime/provider cannot be recalled. Cancel affected work, stop/recreate
matching runtimes, refresh their secret files, and rotate the provider key if
strong revocation is required. Preserve state/volumes and the prior release.
Never downgrade only a manager while leaving HTTP key files for an old launcher.

## Evidence and limits

`tests/test_model_http_policy.py`, `tests/model_http_policy.test.mjs` and the
shared URL corpus exercise the API -> issued payload -> Python/JS consumer ->
request/result chain. Tests use synthetic credentials and loopback-only wire
fixtures. Public fixture IP literals are never dialed. Real urllib/node:http/
fetch redirect tests prove no second-target requests or Authorization forwarding;
negative tests cover policy removal, capabilities and old-image refusal.

These tests are not independent security approval, real-provider acceptance,
cryptographic prompt proof, or a production deployment. Require review and the
normal merged-green release gate, then configure only the explicitly authorized
endpoint and run real skill/private-chat acceptance on a test account.
