import { env } from '$env/dynamic/private';
import { isNoLoginEmail } from '../no-login';

/**
 * Transactional email via Resend's REST API (https://resend.com/docs).
 *
 * Called with `fetch` rather than the `resend` SDK: the only endpoint this
 * portal needs is POST /emails, and adding a dependency to wrap one request
 * would also pull the SDK's own fetch polyfills into the adapter-node bundle.
 *
 * Sending NEVER throws. Every caller here is a side effect of work that has
 * already been committed — an account exists in Postgres by the time we try to
 * mail its credentials — so a Resend outage must not roll that back or fail the
 * request. Failures come back as a result object for the caller to surface and
 * for the operator to retry by hand.
 */

/** Resend caps a single request at 50 recipients; we send one message per person anyway. */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Where employees are told to sign in. Overridable so staging mail does not
 * point people at production.
 */
const DEFAULT_PORTAL_URL = 'https://champ-hr.com';

/**
 * Resend refuses to send from a domain that is not verified in the account, so
 * this has to be an address on one that is. `offer.championsmail.com` is the
 * verified sending domain; `champ-hr.com` is only where the portal is reached,
 * which is why the From address and the portal link do not share a domain.
 */
const DEFAULT_FROM = 'Champ HR <no-reply@offer.championsmail.com>';

function config() {
	const apiKey = env.RESEND_API_KEY ?? '';
	return {
		apiKey,
		from: env.RESEND_FROM || DEFAULT_FROM,
		portalUrl: (env.PORTAL_URL || DEFAULT_PORTAL_URL).replace(/\/+$/, '')
	};
}

export function isMailerConfigured(): boolean {
	return Boolean(config().apiKey);
}

/** The signing secret for inbound Resend webhooks (delivery/bounce events). */
export function webhookSecret(): string {
	return env.RESEND_WEBHOOK_SECRET ?? '';
}

export interface SendResult {
	ok: boolean;
	/** Resend's message id, for correlating with their dashboard and webhooks. */
	id?: string;
	error?: string;
}

export interface SendEmailInput {
	to: string;
	subject: string;
	html: string;
	text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
	// A placeholder for someone with no login (src/lib/no-login.ts) is not a
	// mailbox; refused here so no caller can bounce mail off it.
	if (isNoLoginEmail(input.to)) {
		return { ok: false, error: 'This person has no login and no email address' };
	}
	const { apiKey, from } = config();
	if (!apiKey) {
		return { ok: false, error: 'RESEND_API_KEY is not set' };
	}

	try {
		const res = await fetch(RESEND_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from,
				to: [input.to],
				subject: input.subject,
				html: input.html,
				text: input.text
			})
		});

		// Resend reports quota, domain and validation problems as a JSON body on a
		// non-2xx, so read the message rather than just the status — "domain is not
		// verified" and "rate limit exceeded" need very different operator action.
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			let message = `Resend returned ${res.status}`;
			try {
				const parsed = JSON.parse(detail) as { message?: string; name?: string };
				if (parsed.message) message = parsed.message;
			} catch {
				if (detail) message = detail.slice(0, 200);
			}
			return { ok: false, error: message };
		}

		const body = (await res.json().catch(() => ({}))) as { id?: string };
		return { ok: true, id: body.id };
	} catch (err) {
		// Network-level failure (DNS, timeout, egress blocked).
		return { ok: false, error: err instanceof Error ? err.message : 'Unknown send error' };
	}
}

export interface WelcomeEmailInput {
	fullName: string;
	/** The employee's login id — this portal authenticates by email address. */
	username: string;
	/**
	 * Null while Clerk is the sign-in: there is no password to hand over, the
	 * email explains the emailed-code sign-in instead.
	 */
	temporaryPassword: string | null;
	/**
	 * Delivery address, when it differs from the login id. Normally omitted so
	 * credentials go to the account's own mailbox; set during a dry run to route
	 * every message to one reviewer instead of to real staff.
	 */
	to?: string;
	/** Overrides the configured portal URL; used by tests. */
	portalUrl?: string;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** First name only — the tracker carries full legal names, which read stiffly in a greeting. */
function firstName(fullName: string): string {
	const trimmed = fullName.trim();
	if (!trimmed) return 'there';
	return trimmed.split(/\s+/)[0];
}

/**
 * The credentials handover for a newly created account.
 *
 * Built as a plain string rather than a Svelte component because mail clients
 * need inlined styles and no <head>; component rendering would buy nothing and
 * make the output harder to reason about.
 */
export function buildWelcomeEmail(input: WelcomeEmailInput): { subject: string; html: string; text: string } {
	const portalUrl = (input.portalUrl || config().portalUrl).replace(/\/+$/, '');
	const subject = 'Your Champ HR portal login';

	const text = [
		`Hi ${firstName(input.fullName)},`,
		'',
		'Your Champ HR employee self-service account is ready.',
		'',
		`Portal:   ${portalUrl}`,
		`Username: ${input.username}`,
		...(input.temporaryPassword
			? [
					`Password: ${input.temporaryPassword}`,
					'',
					'You will be asked to set your own password the first time you sign in.',
					'This temporary password stops working at that point.'
				]
			: [
					'',
					'To sign in, open the portal and enter your work email address. We will',
					'email you a 6-digit code; type it in, then choose your own password.'
				]),
		'',
		'Please do not share these details with anyone. If you did not expect this',
		'email, contact the HR team.',
		'',
		'— Champ HR'
	].join('\n');

	const html = `<!doctype html>
<html>
	<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2430;">
		<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
			<tr>
				<td style="padding:24px 28px;background:#2b3a67;color:#ffffff;">
					<h1 style="margin:0;font-size:18px;font-weight:600;">Champ HR</h1>
				</td>
			</tr>
			<tr>
				<td style="padding:28px;">
					<p style="margin:0 0 16px;font-size:15px;">Hi ${escapeHtml(firstName(input.fullName))},</p>
					<p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
						Your Champ HR employee self-service account is ready.
					</p>
					<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f4f5f7;border-radius:8px;margin:0 0 20px;">
						<tr>
							<td style="padding:16px 18px;font-size:14px;line-height:1.7;">
								<strong style="color:#5b6478;">Username</strong><br />
								<span style="font-family:Consolas,Menlo,monospace;">${escapeHtml(input.username)}</span>${
									input.temporaryPassword
										? `<br />
								<strong style="color:#5b6478;">Temporary password</strong><br />
								<span style="font-family:Consolas,Menlo,monospace;">${escapeHtml(input.temporaryPassword)}</span>`
										: ''
								}
							</td>
						</tr>
					</table>
					<p style="margin:0 0 24px;">
						<a href="${escapeHtml(portalUrl)}" style="display:inline-block;padding:11px 20px;background:#2b3a67;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Sign in to the portal</a>
					</p>
					<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#5b6478;">
						${
							input.temporaryPassword
								? 'You will be asked to set your own password the first time you sign in — the temporary one above stops working at that point.'
								: 'Enter your work email address on the sign-in page. We will email you a 6-digit code; type it in, then choose your own password.'
						}
					</p>
					<p style="margin:0;font-size:13px;line-height:1.5;color:#8a92a6;">
						Please do not share these details with anyone. If you did not expect this
						email, contact the HR team.
					</p>
				</td>
			</tr>
		</table>
	</body>
</html>`;

	return { subject, html, text };
}

/** Creates the account holder's credentials mail and sends it. */
export async function sendWelcomeEmail(input: WelcomeEmailInput): Promise<SendResult> {
	const { subject, html, text } = buildWelcomeEmail(input);
	// The body always names the real login id even when delivery is redirected,
	// so a redirected copy still shows what the employee would have received.
	return sendEmail({ to: input.to || input.username, subject, html, text });
}
