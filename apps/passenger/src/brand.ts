import { APP_TAGLINE } from '@yatri/shared';
import type { SignInIdentity } from '@yatri/mobile-auth';

/** This app's wordmark: its words and its accent. The mark itself is the shared Wordmark in @yatri/mobile-ui. */
export const BRAND = { label: 'Yatri', tone: 'primary' } as const;

/** What the shared sign-in screens say for this app. */
export const SIGN_IN: SignInIdentity = {
  ...BRAND,
  tagline: APP_TAGLINE,
  phonePrompt: 'We’ll text you a code to sign in or create your account.',
};
