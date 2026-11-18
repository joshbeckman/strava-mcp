# strava-mcp

A Cloudflare Worker that relays Strava's MCP server, so a build or a script can read
strength-training set data that Strava's REST API does not expose.

## Why this exists

Strava's public REST API has no exercise data. Its detailed activity carries one lap, heart
rate, calories, photos and a free-text description, and that is all. The exercise breakdown
(sets, reps, weight, duration, muscle groups) is only available through
`https://mcp.strava.com/mcp`, tool `get_strength_workout_details`.

That MCP server has an awkward OAuth gate: `register_client` only accepts the client name
`Claude`, which returns the shared client `248572`, and `authorize` only accepts loopback
redirect URIs (`http://localhost:*`). A Worker can never receive the authorization code.

So this Worker owns the tokens, not the login. Someone completes the loopback flow once,
pastes the callback URL into `tools/strava-mcp.py exchange` in pana's memory repo, and seeds
the resulting refresh token here with one `POST /bootstrap`. From then on the Worker refreshes
on its own and is the single owner of that rotation chain, which matters because Strava
invalidates the old refresh token on every refresh.

## Routes

Every route needs `Authorization: Bearer $SHARED_SECRET`. Without it: 401.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Token check; returns `{"ok":true,"token_preview":"7c2e..."}` |
| POST | `/bootstrap` | Seed tokens: `{"refresh_token":"..."}` (optional `access_token`, `access_expires`) |
| GET | `/tools` | `tools/list` result: 14 tools including `get_strength_workout_details` |
| POST | `/call` | `{"tool":"get_activity_streams","arguments":{...}}` -> unwrapped tool result |
| GET | `/strength?ids=1,2` | Convenience wrapper: parsed `get_strength_workout_details` array |

`/strength` returns:

```json
[
  {
    "activity_id": "21014789352",
    "exercise_sets": [
      {
        "exercise_name": "Bench Press",
        "muscle_groups": ["Chest", "Triceps", "Shoulders"],
        "weight": { "value": "115.1 lb", "unit": "Volume" },
        "reps": { "value": "8", "unit": "Steps" },
        "duration": { "value": "1m 10s", "unit": "Time" }
      }
    ]
  }
]
```

Weight, reps and duration are display strings from Strava, already in the athlete's preferred
units; pass them through rather than converting. `unit` is a category label, not a measure.

## Tokens

Tokens live in a single Durable Object (`TokenStore`), not KV. Two concurrent refreshes would
invalidate each other and force a manual re-bootstrap; a DO serializes them.

## Deploy

```sh
npm install
npx wrangler deploy
printf '%s' "$SECRET" | npx wrangler secret put SHARED_SECRET
```

`SHARED_SECRET` is generated once (`openssl rand -hex 32`) and stored in pana's `s` store as
`STRAVA_MCP_WORKER_SECRET`; the same value goes into the consuming repo's CI secrets.
