'use client';

/** Whether this browser can use passkeys at all (and the page is on a secure address). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function';
}

/** A plain-language reason when the browser's passkey prompt did not finish. */
export function passkeyErrorMessage(err: unknown, action: 'sign in' | 'add'): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return action === 'sign in'
      ? 'The passkey prompt was closed or timed out. Try again, or use your password or a recovery code.'
      : 'The passkey prompt was closed or timed out. Nothing was added; try again.';
  }
  if (name === 'InvalidStateError') return 'This phone or computer already has a passkey for the Admin Hub.';
  if (name === 'SecurityError') return 'Passkeys don’t work at this address. Open the shop at its https:// address and try again.';
  if (name === 'NotSupportedError') return 'This browser can’t make passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.';
  return action === 'sign in' ? 'Passkey sign-in did not work. Use your password or a recovery code.' : 'The passkey could not be added. Please try again.';
}

/** The browser half of WebAuthn, loaded only when a passkey is actually used. */
export function webauthnBrowser() {
  return import('@simplewebauthn/browser');
}
