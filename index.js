#!/usr/bin/env node

// SSH Plugin for xyOps
// Copyright (c) 2026 PixlCore LLC
// MIT License

const fs = require('fs');
const { createHash } = require('crypto');
const { Client } = require('ssh2');

class HandledError extends Error {}

const app = {
	conn: null,
	stream: null,
	finalSent: false,
	remoteSentFinal: false,
	shuttingDown: false,
	stdoutBuffer: '',
	verbose: false,
	exitCode: 0,
	exitSignal: '',
	
	async run() {
		const { raw, job } = await readJob();
		this.rawJob = raw;
		this.job = job;
		this.params = job.params || {};
		this.verbose = toBool(this.params.verbose);
		
		const mode = String(this.params.tool || 'script').trim() || 'script';
		if (!TOOLS[mode]) fatal('params', `Unknown run mode: ${mode}`);
		
		const secrets = collectSecrets(job);
		const target = parseTarget(
			String(this.params.hostname || '').trim(),
			String(this.params.username || '').trim(),
			this.params.port
		);
		const auth = resolveAuth(this.params, secrets);
		const remoteCommand = String(this.params.remote_command || '').trim();
		if (!remoteCommand) fatal('params', "Required parameter 'remote_command' was not provided.");
		
		const connectTimeoutSec = toPositiveInt(this.params.connect_timeout_sec, 30);
		const remoteEnv = buildRemoteEnv(job, this.params, secrets, mode);
		const bootstrap = buildBootstrap(remoteEnv, remoteCommand);
		const sshConfig = buildSshConfig(target, auth, this.params.host_fingerprint, connectTimeoutSec);
		
		this.installSignalHandlers();
		this.log(`Connecting to ${target.username}@${target.host}:${target.port} (${mode})`);
		this.log(`Remote command: ${remoteCommand}`);
		
		await this.connect(sshConfig);
		await this.exec(bootstrap);
		
		const payload = (mode === 'job_json')
			? ensureTrailingNewline(this.rawJob)
			: ensureTrailingNewline(String(this.params.script || ''));
		
		if ((mode === 'script') && !payload.trim()) {
			fatal('params', "Required parameter 'script' was not provided.");
		}
		
		this.stream.end(payload);
	},
	
	connect(config) {
		return new Promise((resolve, reject) => {
			const conn = new Client();
			this.conn = conn;
			
			conn.once('ready', () => {
				conn.on('error', (err) => {
					if (this.shuttingDown || this.finalSent) return;
					this.fail('ssh', err && err.message ? err.message : 'SSH connection error.');
				});
				resolve();
			});
			conn.once('error', reject);
			
			conn.connect(config);
		});
	},
	
	exec(bootstrap) {
		return new Promise((resolve, reject) => {
			const command = `/bin/sh -lc ${quoteShell(bootstrap)}`;
			this.conn.exec(command, (err, stream) => {
				if (err) return reject(err);
				this.stream = stream;
				
				stream.on('data', (chunk) => this.handleStdout(chunk));
				stream.stderr.on('data', (chunk) => process.stderr.write(chunk));
				stream.on('exit', (code, signal) => {
					this.exitCode = (typeof code === 'number') ? code : 0;
					this.exitSignal = signal || '';
				});
				stream.on('close', () => this.handleClose());
				
				resolve(stream);
			});
		});
	},
	
	handleStdout(chunk) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
		process.stdout.write(text);
		this.stdoutBuffer += text;
		
		let idx = 0;
		while ((idx = this.stdoutBuffer.indexOf('\n')) > -1) {
			const line = this.stdoutBuffer.slice(0, idx).replace(/\r$/, '');
			this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
			this.inspectLine(line);
		}
	},
	
	inspectLine(line) {
		if (!line || !line.trim()) return;
		try {
			const msg = JSON.parse(line);
			if (msg && (msg.xy === 1) && Object.prototype.hasOwnProperty.call(msg, 'code')) {
				this.remoteSentFinal = true;
			}
		}
		catch (err) {
			// ignore plain text output
		}
	},
	
	handleClose() {
		if (this.stdoutBuffer) {
			this.inspectLine(this.stdoutBuffer.replace(/\r$/, ''));
			this.stdoutBuffer = '';
		}
		
		if (this.conn) {
			try { this.conn.end(); }
			catch (err) {;}
		}
		
		if (this.shuttingDown || this.finalSent) return process.exit(0);
		if (this.remoteSentFinal) return process.exit(0);
		
		if (this.exitSignal) {
			return this.sendFinal({
				code: `signal:${this.exitSignal}`,
				description: `Remote command exited due to signal ${this.exitSignal}.`
			});
		}
		
		if (this.exitCode) {
			return this.sendFinal({
				code: this.exitCode,
				description: `Remote command exited with code ${this.exitCode}.`
			});
		}
		
		return this.sendFinal({ code: 0 });
	},
	
	sendFinal(payload) {
		if (this.finalSent) return;
		this.finalSent = true;
		payload.xy = 1;
		process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0));
	},
	
	fail(code, description) {
		this.sendFinal({ code, description });
	},
	
	log(message) {
		if (this.verbose) process.stderr.write(`[xyplug-ssh] ${message}\n`);
	},
	
	installSignalHandlers() {
		const handler = (signal) => {
			this.shuttingDown = true;
			this.log(`Caught ${signal}, closing SSH session.`);
			try {
				if (this.stream) this.stream.close();
			}
			catch (err) {;}
			try {
				if (this.conn) this.conn.end();
			}
			catch (err) {;}
			setTimeout(() => process.exit(0), 250).unref();
		};
		
		process.once('SIGTERM', () => handler('SIGTERM'));
		process.once('SIGINT', () => handler('SIGINT'));
	}
};

const TOOLS = {
	script: true,
	job_json: true
};

async function readJob() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) fatal('input', 'No JSON input received on STDIN.');
	
	try {
		return { raw, job: JSON.parse(raw) };
	}
	catch (err) {
		fatal('input', `Failed to parse JSON input: ${err.message}`);
	}
}

function parseTarget(hostname, username, portFallback) {
	const host = String(hostname || '').trim();
	const user = String(username || '').trim();
	const port = toPositiveInt(portFallback, 22);
	
	if (!host) fatal('params', "Required parameter 'hostname' was not provided.");
	if (!user) fatal('params', "Required parameter 'username' was not provided.");
	
	return { host, port, username: user };
}

function resolveAuth(params, secrets) {
	let privateKey = resolveNamedValue('SSH_PRIVATE_KEY', secrets);
	const passphrase = resolveNamedValue('SSH_PASSPHRASE', secrets);
	const password = resolveNamedValue('SSH_PASSWORD', secrets);
	const agent = process.env.SSH_AUTH_SOCK || '';
	
	// private key may be specified as a file path in params
	if (params.private_key_file) {
		try { privateKey = fs.readFileSync(params.private_key_file, 'utf8'); }
		catch (err) {
			fatal( 'auth', 'Failed to read private key file: ' + params.private_key_file + ": " + err );
		}
	}
	
	if (!privateKey && !password && !agent) {
		fatal(
			'auth',
			'No SSH auth credentials were found. Set SSH_PRIVATE_KEY, SSH_PASSWORD, or provide an ssh-agent via SSH_AUTH_SOCK.'
		);
	}
	
	return { privateKey, passphrase, password, agent };
}

function resolveNamedValue(name, secrets) {
	if (!name) return '';
	if (Object.prototype.hasOwnProperty.call(secrets, name)) return String(secrets[name]);
	if (Object.prototype.hasOwnProperty.call(process.env, name)) return String(process.env[name]);
	return '';
}

function buildSshConfig(target, auth, fingerprint, connectTimeoutSec) {
	const config = {
		host: target.host,
		port: target.port,
		username: target.username,
		readyTimeout: connectTimeoutSec * 1000,
		keepaliveInterval: 15000,
		keepaliveCountMax: 4
	};
	
	if (auth.privateKey) config.privateKey = Buffer.from(auth.privateKey, 'utf8');
	if (auth.passphrase) config.passphrase = auth.passphrase;
	if (auth.password) config.password = auth.password;
	if (!auth.privateKey && !auth.password && auth.agent) config.agent = auth.agent;
	
	const expected = String(fingerprint || '').trim();
	if (expected) {
		config.hostVerifier = function(hostKey) {
			const actualSha256 = `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
			const actualMd5 = createHash('md5').update(hostKey).digest('hex').match(/.{2}/g).join(':');
			return matchesFingerprint(expected, actualSha256, actualMd5);
		};
	}
	
	return config;
}

function matchesFingerprint(expected, actualSha256, actualMd5) {
	const value = String(expected || '').trim();
	if (!value) return true;
	if (/^sha256:/i.test(value)) return value === actualSha256;
	if (/^[a-f0-9]{2}(?::[a-f0-9]{2}){15}$/i.test(value)) return value.toLowerCase() === actualMd5.toLowerCase();
	return (`SHA256:${value.replace(/^SHA256:/i, '').replace(/=+$/, '')}` === actualSha256);
}

function collectSecrets(job) {
	const secrets = {};
	if (!job || !job.secrets || (typeof job.secrets !== 'object') || Array.isArray(job.secrets)) return secrets;
	
	for (const [key, value] of Object.entries(job.secrets)) {
		if (!isValidEnvName(key) || (value === undefined) || (value === null)) continue;
		secrets[key] = String(value);
	}
	
	return secrets;
}

function buildRemoteEnv(job, params, secrets, mode) {
	const env = {};
	
	for (const [key, value] of Object.entries(secrets)) {
		if (!/^(SSH_)/.test(key)) continue;
		env[key] = value;
	}
	
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(XYOPS_|JOB_)/.test(key)) continue;
		if (!isValidEnvName(key)) continue;
		if (value === undefined || value === null) continue;
		env[key] = String(value);
	}
	
	const meta = {
		XYOPS_JOB_ID: job.id || '',
		XYOPS_EVENT_ID: job.event || '',
		XYOPS_PLUGIN_ID: job.plugin || '',
		XYOPS_SERVER_ID: job.server || '',
		XYOPS_BASE_URL: job.base_url || '',
		XYOPS_RUN_MODE: mode
	};
	
	for (const [key, value] of Object.entries(meta)) {
		if (value !== undefined && value !== null && value !== '') env[key] = String(value);
	}
	
	for (const [key, value] of Object.entries(params)) {
		if (KNOWN_PARAM_KEYS.has(key)) continue;
		if (!isValidEnvName(key)) continue;
		if ((typeof value === 'string') || (typeof value === 'number')) {
			env[key] = String(value);
		}
	}
	
	const extra = params.remote_env;
	if (extra !== undefined && extra !== null) {
		if ((typeof extra !== 'object') || Array.isArray(extra)) {
			fatal('params', "Parameter 'remote_env' must be a JSON object.");
		}
		
		for (const [key, value] of Object.entries(extra)) {
			if (!isValidEnvName(key)) fatal('params', `Invalid remote_env key: ${key}`);
			env[key] = normalizeEnvValue(value);
		}
	}
	
	return env;
}

function normalizeEnvValue(value) {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if ((typeof value === 'number') || (typeof value === 'boolean')) return String(value);
	return JSON.stringify(value);
}

function buildBootstrap(env, remoteCommand) {
	const lines = [
		'decode_b64() {',
		'  if command -v base64 >/dev/null 2>&1; then',
		'    base64 --decode 2>/dev/null || base64 -d 2>/dev/null || base64 -D 2>/dev/null;',
		'  elif command -v openssl >/dev/null 2>&1; then',
		'    openssl base64 -d -A;',
		'  else',
		'    echo "Missing base64 or openssl on remote host." >&2;',
		'    return 127;',
		'  fi',
		'}'
	];
	
	for (const key of Object.keys(env).sort()) {
		const encoded = Buffer.from(String(env[key]), 'utf8').toString('base64');
		lines.push(`export ${key}="$(printf %s ${quoteShell(encoded)} | decode_b64)"`);
	}
	
	lines.push(`exec ${remoteCommand}`);
	return lines.join('\n');
}

function isValidEnvName(name) {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''));
}

function toBool(value) {
	if ((value === true) || (value === false)) return value;
	const text = String(value || '').trim().toLowerCase();
	return (text === '1') || (text === 'true') || (text === 'yes') || (text === 'on');
}

function toPositiveInt(value, fallback) {
	const num = parseInt(value, 10);
	return Number.isFinite(num) && (num > 0) ? num : fallback;
}

function ensureTrailingNewline(text) {
	const value = String(text || '');
	return value.endsWith('\n') ? value : `${value}\n`;
}

function quoteShell(text) {
	return `'${String(text).replace(/'/g, `'\"'\"'`)}'`;
}

const KNOWN_PARAM_KEYS = new Set([
	'hostname',
	'username',
	'port',
	'host_fingerprint',
	'connect_timeout_sec',
	'remote_env',
	'verbose',
	'tool',
	'remote_command',
	'script'
]);

function fatal(code, description) {
	app.fail(code, description);
	throw new HandledError(description);
}

app.run().catch((err) => {
	if (err instanceof HandledError) return;
	if (app.verbose && err) {
		process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
	}
	app.fail('error', err && err.message ? err.message : 'Unknown error');
});
