# Linux + OpenClaw

Runtime: Node.js 22 or newer. The service uses Streamable HTTP at
`http://127.0.0.1:28981/mcp`; it is deliberately bound to loopback.
The existing stdio entry point remains `node src/mcp.mjs`.

## Install

Place the runtime checkout at `/opt/mts-calls-mcp` and run:

```sh
cd /opt/mts-calls-mcp
npm ci --omit=dev --ignore-scripts
sudo useradd --system --home /var/lib/mts-calls-mcp --shell /usr/sbin/nologin mts-calls
sudo install -d -o mts-calls -g mts-calls -m 700 /var/lib/mts-calls-mcp
```

Transfer these files securely from your own authenticated setup into that
state directory: `mts-session.json`, `production-modern.pfx`,
`production-modern.passphrase`. Do not copy HARs, APKs or transcript dumps.
The account must already have confirmed access to recordings.

Generate a distinct MCP bearer token on the server, then set ownership and
permissions. The service must be able to replace the session file for refresh:

```sh
sudo sh -c 'umask 077; openssl rand -hex 48 > /var/lib/mts-calls-mcp/mcp-token'
sudo chown -R mts-calls:mts-calls /var/lib/mts-calls-mcp
sudo chmod 600 /var/lib/mts-calls-mcp/*
sudo install -m 644 deploy/mts-calls-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mts-calls-mcp
```

Inspect existing state before installing over an earlier deployment. The
unit runs as a dedicated user, restarts after failure and starts after reboot.
Only `/var/lib/mts-calls-mcp` is writable. No public nginx route or firewall
opening is required when OpenClaw runs on the same server.

## Connect OpenClaw

The tested OpenClaw version is 2026.7.1-2. Its native MCP client accepts
`mcp.servers` entries. Merge this entry into the actual gateway owner's config
and keep that file private; replace the placeholder locally with mcp-token:

```json
{
  "mcp": {
    "servers": {
      "mts-calls": {
        "url": "http://127.0.0.1:28981/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer <local MCP token>" },
        "timeout": 300,
        "connectTimeout": 10,
        "toolFilter": {
          "include": ["mts_connection_status", "mts_list_calls", "mts_get_transcript", "mts_search_transcripts"]
        }
      }
    }
  }
}
```

Preserve a private backup before editing. Validate and probe as that user:

```sh
openclaw config validate
openclaw mcp probe mts-calls --json
```

Restart the gateway if it already cached its MCP catalog. The remote runtime
exposes four API tools; USB tools remain available only through the local
stdio entry point. In OpenClaw they appear as `mts-calls__mts_list_calls`, etc.
The normal coding tool profile exposes them. See the
[official MCP documentation](https://docs.openclaw.ai/cli/mcp).

Try: «Покажи последние звонки МТС» or «Прочитай готовую расшифровку выбранного
звонка». A call's records contain IDs and transcription readiness; choose a
record with `transcription_status=done` to avoid starting processing.

## Operate

```sh
sudo systemctl status mts-calls-mcp
sudo journalctl -u mts-calls-mcp -n 30 --no-pager
sudo systemctl restart mts-calls-mcp
```

`/healthz` reports process health and also requires the MCP bearer token.
`mts_connection_status` with verify=true checks the actual MTS API.
Secrets and transcript bodies are not written to the service log. Tool results
can be stored by OpenClaw in its private session history.

The HTTP service checks expiry every five minutes, refreshing when due even
without tool calls. Requests also check expiry. An expired or
revoked upstream session may require a new personal login. The current
client-channel certificate expires in May 2027; updating it requires obtaining
the new credential from your own application setup. Keep private backups of
the state directory; do not put it in Git or a public container image.

To update code, install the new locked dependencies and restart only
`mts-calls-mcp`; its state remains outside the checkout. To roll back, restore
the previous code and unit. Removing the OpenClaw entry and stopping the unit
disconnects this integration without changing MTS account settings.
