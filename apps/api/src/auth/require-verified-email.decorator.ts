import { SetMetadata } from '@nestjs/common';

export const REQUIRE_VERIFIED_EMAIL = 'requireVerifiedEmail';

export const EMAIL_UNVERIFIED_REASON = 'email_unverified';

// The 403 of a route that needs a confirmed address. It names the way out.
export interface EmailUnverifiedPayload {
  reason: typeof EMAIL_UNVERIFIED_REASON;
  message: string;
}

export const EMAIL_UNVERIFIED_MESSAGE =
  'Confirm your email address first: request a code with POST /auth/email/verify-request';

export const EMAIL_UNVERIFIED_FORBIDDEN_DOC =
  'Or `{ "reason": "email_unverified" }`: the account has not confirmed its ' +
  'email address (POST /auth/email/verify-request).';

// Marks a route that creates public content: it needs a confirmed email
// address, checked by AuthGuard after authentication. The routes that carry
// it are deliberate and listed in the README ("Email verification"):
// creating posts, comments, communities and uploads. Reading, voting,
// reporting, account settings and leaving never do.
export const RequireVerifiedEmail = () =>
  SetMetadata(REQUIRE_VERIFIED_EMAIL, true);
