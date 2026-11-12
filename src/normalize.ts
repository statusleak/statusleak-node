// Replaces IDs in URL paths with ":id" so calls group into a bounded set of
// operations: /v1/customers/cus_NffrFeUfNV2Hib → /v1/customers/:id.
//
// The StatusLeak server applies the same algorithm again on ingest. Both are
// tested against the shared cases in tests/fixtures/normalize-cases.json.

const MAX_SEGMENTS = 12;
const MAX_LENGTH = 256;

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
// Stripe-style prefixed IDs: cus_…, pi_…, sk_live_… (prefix + long random tail)
const PREFIXED = /^[a-z][a-z0-9]{1,15}(?:_[a-z0-9]{1,15})?_[A-Za-z0-9]{8,}$/;
// Twilio SIDs: two uppercase letters + 32 hex chars (AC…, SM…, VA…)
const TWILIO_SID = /^[A-Z]{2}[0-9a-f]{32}$/;
// Long opaque tokens mixing letters and digits (base62/base64url IDs, ULIDs)
const OPAQUE = /^[A-Za-z0-9_-]{20,}$/;
// Personal data some APIs put in paths: emails (SendGrid suppressions, HubSpot
// contacts) and phone numbers (Twilio Lookup), raw or URL-encoded.
const EMAIL = /@|%40/i;
// International format only (+…), so dates like Twilio's /2010-04-01/ stay.
const PHONE = /^(?:\+|%2B)[\d\-().]{7,}$/i;

function isPersonal(segment: string): boolean {
    if (EMAIL.test(segment)) {
        return true;
    }
    return PHONE.test(segment) && (segment.match(/\d/g) ?? []).length >= 7;
}

function looksLikeId(segment: string): boolean {
    if (NUMERIC.test(segment) || UUID.test(segment) || HEX.test(segment) || TWILIO_SID.test(segment) || PREFIXED.test(segment)) {
        return true;
    }
    return OPAQUE.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

function normalizeSegment(segment: string): string {
    // Whole segment, before looking at extensions: jane@acme.com must not keep ".com".
    if (isPersonal(segment)) {
        return ':id';
    }
    // Keep extensions and Google-style ":verb" suffixes: AC123….json → :id.json
    const m = /^([^.:]+)([.:].*)?$/.exec(segment);
    if (!m) {
        return segment;
    }
    const [, base, suffix = ''] = m;
    if (looksLikeId(base)) {
        return `:id${suffix}`;
    }
    return segment;
}

export function normalizePath(rawPath: string): string {
    let path = rawPath;
    const q = path.search(/[?#]/);
    if (q !== -1) {
        path = path.slice(0, q);
    }
    if (!path.startsWith('/')) {
        path = `/${path}`;
    }
    let segments = path.split('/').slice(1);
    if (segments.length > MAX_SEGMENTS) {
        segments = [...segments.slice(0, MAX_SEGMENTS), '…'];
    }
    let out = `/${segments.map(normalizeSegment).join('/')}`;
    if (out.length > MAX_LENGTH) {
        out = `${out.slice(0, MAX_LENGTH)}…`;
    }
    return out;
}
