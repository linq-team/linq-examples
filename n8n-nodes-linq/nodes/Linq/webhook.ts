import {
	createHmac,
	timingSafeEqual,
	createHash,
	createCipheriv,
	createDecipheriv,
	randomBytes,
} from 'crypto';
export function verifyWebhook(
	raw: Buffer,
	headers: Record<string, unknown>,
	secret: string,
	now = Date.now(),
): void {
	const id = headers['webhook-id'];
	const timestamp = headers['webhook-timestamp'];
	const signature = headers['webhook-signature'];
	if (
		typeof id !== 'string' ||
		!id ||
		typeof timestamp !== 'string' ||
		!/^\d+$/.test(timestamp) ||
		typeof signature !== 'string'
	)
		throw new Error('Missing signature');
	if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('Expired signature');
	const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
	if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
		throw new Error('Invalid signing secret');
	const key = Buffer.from(encoded, 'base64');
	if (key.length === 0) throw new Error('Invalid signing secret');
	const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
	const valid = signature.split(' ').some((part) => {
		const [version, value] = part.split(',');
		if (version !== 'v1' || !value) return false;
		const actual = Buffer.from(value, 'base64');
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	});
	if (!valid) throw new Error('Invalid signature');
}

// The API returns this secret only once. Persist authenticated ciphertext instead
// of putting a second plaintext credential in workflow static data.
function encryptionKey(apiKey: string): Buffer {
	return createHash('sha256').update('linq-n8n-webhook-secret:v1:').update(apiKey).digest();
}
export function sealSecret(secret: string, apiKey: string, subscriptionId: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(apiKey), iv);
	cipher.setAAD(Buffer.from(subscriptionId));
	const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64')).join('.');
}
export function openSecret(sealed: string, apiKey: string, subscriptionId: string): string {
	const parts = sealed.split('.');
	if (parts.length !== 3) throw new Error('Invalid encrypted signing secret');
	const [iv, tag, encrypted] = parts.map((value) => Buffer.from(value, 'base64'));
	const decipher = createDecipheriv('aes-256-gcm', encryptionKey(apiKey), iv);
	decipher.setAAD(Buffer.from(subscriptionId));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
