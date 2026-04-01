import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { fail } from '@sveltejs/kit';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ENTRY_COOKIE = 'mtgvote_entry_unlocked';
const ENTRY_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const SESSION_TOKEN_VERSION = 'v1';

function getSessionSecret() {
	return env.PRIVATE_ENTRY_SESSION_SECRET || env.PRIVATE_ENTRY_PASSPHRASE || '';
}

/** @param {string} payload @param {string} secret */
function signPayload(payload, secret) {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** @param {string} actual @param {string} expected */
function safeSignatureEquals(actual, expected) {
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	if (a.length !== b.length) {
		return false;
	}

	return timingSafeEqual(a, b);
}

/** @param {number} nowMs @param {string} secret */
function createSessionToken(nowMs, secret) {
	const expiresAtMs = nowMs + ENTRY_COOKIE_MAX_AGE * 1000;
	const payload = `${SESSION_TOKEN_VERSION}.${expiresAtMs}`;
	const signature = signPayload(payload, secret);
	return `${payload}.${signature}`;
}

/** @param {string} token @param {number} nowMs @param {string} secret */
function isValidSessionToken(token, nowMs, secret) {
	if (!token || !secret) {
		return false;
	}

	const parts = token.split('.');
	if (parts.length !== 3) {
		return false;
	}

	const [version, expiresAtRaw, signature] = parts;
	if (version !== SESSION_TOKEN_VERSION || !expiresAtRaw || !signature) {
		return false;
	}

	const expiresAtMs = Number(expiresAtRaw);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
		return false;
	}

	const payload = `${version}.${expiresAtRaw}`;
	const expectedSignature = signPayload(payload, secret);
	return safeSignatureEquals(signature, expectedSignature);
}

/** @type {import('./$types').PageServerLoad} */
export function load({ cookies }) {
	const secret = getSessionSecret();
	const token = cookies.get(ENTRY_COOKIE) ?? '';

	return {
		unlocked: isValidSessionToken(token, Date.now(), secret)
	};
}

/** @satisfies {import('./$types').Actions} */
export const actions = {
	unlock: async ({ request, cookies }) => {
		const secret = getSessionSecret();
		const configuredPassphrase = env.PRIVATE_ENTRY_PASSPHRASE || '';
		const formData = await request.formData();
		const passphrase = String(formData.get('passphrase') ?? '').trim();

		if (!configuredPassphrase || !secret) {
			return fail(500, { unlockError: 'Server passphrase session is not configured.' });
		}

		if (passphrase !== configuredPassphrase) {
			return fail(400, { unlockError: 'Incorrect passphrase.' });
		}

		const token = createSessionToken(Date.now(), secret);
		cookies.set(ENTRY_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: !dev,
			maxAge: ENTRY_COOKIE_MAX_AGE
		});

		return { unlockSuccess: true };
	}
};
