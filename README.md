<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-ssh/refs/heads/main/logo.png" height="160" alt="Remote SSH"/></p>
<h1 align="center">Remote SSH</h1>

A remote SSH event plugin for the [xyOps Workflow Automation System](https://xyops.io).  It connects to a remote host over SSH, and then runs either:

- A remote command that receives a script on STDIN
- A remote command that receives the full xyOps job JSON on STDIN

This makes it useful both as a simple remote shell runner and as a transport layer for your own remote XYWP-aware workers.

## Features

- Pure Node.js / `npx` plugin.
- No local `ssh` CLI required.
- Supports private key, passphrase, password, or local `ssh-agent`
- Optional host key fingerprint pinning
- Preserves remote XYWP output when the remote command emits `{"xy":1,...}` lines

## Requirements

- `npx`
- Network access from the xyOps runner host to the remote SSH server
- A POSIX-like remote host with `/bin/sh`
- `base64` or `openssl` available on the remote host for env var bootstrapping
- Whatever remote runtime your command needs, e.g. `bash`, `python`, `node`, etc.

## Secrets / Environment Variables

The plugin looks up SSH auth from environment variables or [xyOps Secrets](https://docs.xyops.io/secrets) using these fixed names:

- `SSH_PRIVATE_KEY`
- `SSH_PASSPHRASE`
- `SSH_PASSWORD`

Put those in your xyOps Secret Vault when needed.

Note that any secret variables that begin with `SSH_` are **not** forwarded to the remote server, by design.  Any *other* assigned xyOps secret variables are forwarded to the remote process environment.

The plugin also exports a few helper variables remotely:

- `XYOPS_JOB_ID`
- `XYOPS_EVENT_ID`
- `XYOPS_PLUGIN_ID`
- `XYOPS_SERVER_ID`
- `XYOPS_BASE_URL`
- `XYOPS_RUN_MODE`

## Plugin Parameters

- `SSH Hostname`: Hostname or IP address
- `Username`: SSH username
- `Port`: SSH port
- `Host Fingerprint`: Optional host key pin, recommended for production
- `Connect Timeout`: SSH connect timeout in seconds
- `Remote Env`: Extra key/value pairs to pass to the remote side
- `Verbose Logging`: Adds connection/debug details to the job log

## Run Modes

### 1. Pipe Script to STDIN

Use this when the remote command is something like `bash -se`, `python -`, or another interpreter that reads source code from STDIN.

Typical example:

- Remote Command: `bash -se`
- Script Source: your shell script

The plugin exports env vars first, then executes the remote command, then pipes your script into its STDIN.

### 2. Pipe Full Job JSON

Use this when the remote command is your own program that expects the full xyOps job payload on STDIN.

Typical example:

- Remote Command: `node /path/to/my-remote-plugin.js`

If the remote program emits XYWP lines such as `{"xy":1,"progress":0.5}` or `{"xy":1,"code":0}`, the plugin passes them straight back to xyOps.

If the remote program does not emit a final XYWP completion message, the plugin falls back to the SSH exit code.

## Local Testing

Install dependencies first:

```bash
npm install
```

Then pipe a sample job JSON into the plugin.

### Script Mode Example

```bash
cat <<'JSON' | node index.js
{
  "xy": 1,
  "type": "event",
  "id": "jtestssh001",
  "event": "etestssh001",
  "plugin": "ptestssh001",
  "server": "local",
  "base_url": "https://xyops.example.com",
  "params": {
    "hostname": "127.0.0.1",
    "username": "deploy",
    "port": 22,
    "connect_timeout_sec": 10,
    "remote_env": {
      "APP_ENV": "dev"
    },
    "tool": "script",
    "remote_command": "bash -se",
    "script": "set -euo pipefail\\necho \\\"remote host: $(hostname)\\\"\\necho \\\"job id: $XYOPS_JOB_ID\\\"\\n"
  },
  "secrets": {
    "SSH_PRIVATE_KEY": "-----BEGIN OPENSSH PRIVATE KEY-----\\nREPLACE_ME\\n-----END OPENSSH PRIVATE KEY-----"
  }
}
JSON
```

### Job JSON Mode Example

```bash
cat <<'JSON' | node index.js
{
  "xy": 1,
  "type": "event",
  "id": "jtestssh002",
  "event": "etestssh002",
  "plugin": "ptestssh002",
  "server": "local",
  "base_url": "https://xyops.example.com",
  "params": {
    "hostname": "127.0.0.1",
    "username": "deploy",
    "port": 22,
    "tool": "job_json",
    "remote_command": "node /opt/xyops/remote-plugin.js"
  },
  "secrets": {
    "SSH_PRIVATE_KEY": "-----BEGIN OPENSSH PRIVATE KEY-----\\nREPLACE_ME\\n-----END OPENSSH PRIVATE KEY-----"
  }
}
JSON
```

## Security Notes

- Prefer private key auth stored in xyOps Secrets over inline passwords.
- Set `Host Fingerprint` in production so the plugin pins the remote host key.

## Data Collection

This plugin does not intentionally collect telemetry, analytics, or usage metrics.

## License

MIT.
