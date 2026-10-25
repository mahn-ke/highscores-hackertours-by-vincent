# highscores.hackertours.by.vincent.mahn.ke

Hosts the container serving [highscores.hackertours.by.vincent.mahn.ke](https://highscores.hackertours.by.vincent.mahn.ke).

Shared Hackertours racing leaderboard for the Nintendo 3DS and Xbox 360 homebrew
ports. Node.js 26, built-in SQLite, and Keycloak client-credentials authentication.
Reads are public; each console platform has its own confidential service account.
The complete machine-readable API is available at `/openapi.json`.

## API

| Method | Path | Authentication | Result |
| --- | --- | --- | --- |
| GET | `/healthz` | None | `{"status":"ok"}` after a database read |
| GET | `/api/scores/:course[?limit=N]` | None | All scores, or the first N |
| GET | `/api/courses` | None | `[{"course":"ccchh","count":1,"bestMs":12345}]`, sorted by course |
| POST | `/api/scores` | Bearer access token | 201 for a new score, 200 for an existing id |

Scores are ordered by `ms ASC`, then `achievedAt ASC`, then canonical id for
otherwise exact ties. Unknown courses return `[]`. `limit` must occur at most once
and be a positive safe integer (maximum 9007199254740991); omit it for all scores.
GET returns exactly:

```json
[{"name":"VIM","ms":12345,"platform":"3ds","achievedAt":1792956000}]
```

POST accepts `Content-Type: application/json`, at most 4096 bytes, with **only**
these five fields:

```json
{"id":"12345678-1234-4234-8234-123456789abc","course":"ccchh","name":"VIM","ms":12345,"achievedAt":1792956000}
```

| Field | Validation |
| --- | --- |
| id | Client-generated UUID-shaped string or 32 hex digits; case-insensitive; stored lowercase without hyphens |
| course | Shared racemap venue id matching `^[a-z0-9_-]{1,31}$` |
| name | Initials matching `^[A-Z0-9._-]{1,3}$` |
| ms | Integer 1–5999999 inclusive |
| achievedAt | Integer Unix **seconds**, at least 1577836800 (2020-01-01), no later than server time +300 seconds |

Keep the same id across retries. After validating the request, a duplicate id
returns the original row unchanged, even when the new valid fields differ.
Both 200 and 201 return `{id,course,name,ms,platform,achievedAt}`. The platform is
assigned exclusively from the token's `azp` claim (`3ds` or `xbox`); never send it
in the body. Sync the console clock before submitting; do not send milliseconds
for `achievedAt`.

Errors are JSON `{"error":"description"}`: 400 for invalid input, 401 for absent,
invalid, wrongly signed or expired tokens, 403 for a signed token from another
client, 404 for unknown routes, and 429 for the per-client quota (60 POST attempts
per fixed server minute, including invalid bodies and retries). Respect the
`Retry-After` seconds on 429. A network failure or 5xx can be retried using the
same id. Refresh the access token on expiration/401, not on every score.

## Console authentication

Terraform in `mahn-ke/repos` creates these separate service accounts:

| Platform | Client id | Private console setting |
| --- | --- | --- |
| Nintendo 3DS | `highscores-hackertours-3ds` | Matching client id and secret in private `config.ini` |
| Xbox 360 | `highscores-hackertours-xbox` | Matching client id and secret in private `config.ini` |

Obtain a token over HTTPS (do not disable certificate verification):

```sh
curl --fail-with-body \
  https://sso.by.vincent.mahn.ke/realms/sso.by.vincent.mahn.ke/protocol/openid-connect/token \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$CONSOLE_CLIENT_ID" \
  --data-urlencode "client_secret=$CONSOLE_CLIENT_SECRET"
```

The JSON response contains `access_token`, `token_type: Bearer`, and `expires_in`
(3600 seconds). Cache it in memory until shortly before expiry. Then submit:

```sh
curl --fail-with-body https://highscores.hackertours.by.vincent.mahn.ke/api/scores \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  --data '{"id":"12345678-1234-4234-8234-123456789abc","course":"ccchh","name":"VIM","ms":12345,"achievedAt":1792956000}'
```

Use the actual completion timestamp, not this example's fixed timestamp.
JWT verification uses the realm's remote JWKS, RS256, exact issuer, expiration,
and required `iat`, `sub`, `azp` claims. No console client secret is needed by the
backend. Browser login, password grants, and refresh-token grants are not enabled.

**Trust boundary:** shared console credentials and client-reported race times
are extractable/forgeable. This provides platform attribution, not player identity
or anti-cheat guarantees. Do not commit secrets, log tokens, or expose Terraform
credential output publicly. A compromised platform secret must be rotated in
Keycloak and replaced on that platform's consoles.

## Configuration and persistence

| Environment | Default / purpose |
| --- | --- |
| PORT | 3000 inside the container |
| DATABASE_PATH | `/data/scores.sqlite` |
| OAUTH_URL | `https://sso.by.vincent.mahn.ke/realms/sso.by.vincent.mahn.ke` (exact issuer) |
| OAUTH_CONSOLE_3DS_CLIENT_ID | Required, allowed 3DS `azp` |
| OAUTH_CONSOLE_XBOX_CLIENT_ID | Required, distinct allowed Xbox `azp` |

Compose publishes host port **3020**, and stores SQLite in named volume `scores`.
The process runs as the unprivileged `node` user. SQLite WAL mode preserves
committed scores across restarts. The generated backup/restore workflows cover
named Compose volumes. For a guaranteed consistent manual snapshot, stop the app
before copying the volume (including any WAL/SHM files), or use SQLite's online
backup API; copying only the live `.sqlite` file can omit committed WAL data.

## Development and deployment

```sh
cd app
npm ci
npm test
OAUTH_CONSOLE_3DS_CLIENT_ID=highscores-hackertours-3ds \
OAUTH_CONSOLE_XBOX_CLIENT_ID=highscores-hackertours-xbox \
DATABASE_PATH=./scores.sqlite npm start
# The deploy workflow uses this exact test target:
docker build --target test .
```

Tests use locally generated RSA keys and an injected local JWKS; no Keycloak or
network service is contacted. Persistence fixtures are project-relative and
removed after testing.

The repository, DNS/proxy setup, deployment and volume backup workflows,
`infrastructure/`, and `service/` scaffolding are generated by `mahn-ke/repos`.
They are intentionally not duplicated here. Applying its infrastructure PR also
sets repository Actions secrets `OAUTH_URL`, `OAUTH_CONSOLE_3DS_CLIENT_ID/SECRET`,
and `OAUTH_CONSOLE_XBOX_CLIENT_ID/SECRET`. Compose passes **only the IDs and
issuer** into this service. Actions secrets cannot be read back; after apply,
retrieve the matching secrets securely from the sensitive Terraform output:

```sh
terraform -chdir=infrastructure output -json highscores_console_credentials
```

Run that command in `mahn-ke/repos` with authorized state access. Copy each
platform's `client_id`, `client_secret`, and `token_url` to its private console
configuration. The credentials are also stored in sensitive Terraform state.

### First push after Terraform creates the repository

Terraform creates remote bootstrap commits, so do not force-push this independent
local history over them. Fetch and merge the generated history, retaining this
implementation if generated starter application files conflict, then push:

```sh
git fetch origin main
git merge --allow-unrelated-histories origin/main
# Resolve any starter-file conflicts, retaining local app/ and docker-compose.yml.
# Keep the generated workflows, infrastructure/ and service/ files.
git push -u origin main
```

If branch protection rejects direct push, push the merged result to a new branch
and open a PR instead. No Terraform apply, service push, or live deployment is
performed while preparing this repository.
