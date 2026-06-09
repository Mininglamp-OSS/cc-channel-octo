/**
 * #115: Cron-fire authenticity marker.
 *
 * Synthetic cron messages bypass the group @mention gate. To stop a malicious
 * group member from forging that bypass by putting `_cronFire: true` in a real
 * message payload, the scheduler stamps each synthetic message with a secret
 * nonce generated ONCE at process start, and the router accepts the bypass only
 * when the nonce matches. The nonce never leaves the process (it is not derived
 * from anything an attacker can observe), so an inbound WS message cannot carry
 * the right value.
 *
 * Shared in its own tiny module so both `cron-scheduler` (stamp) and
 * `session-router` (verify) depend on it without a circular import.
 */

import { randomBytes } from 'node:crypto';

/** Per-process secret. Regenerated each start — synthetic messages are
 *  in-memory and short-lived, so a fresh nonce per process is fine. */
export const CRON_FIRE_NONCE = randomBytes(16).toString('hex');

/** Payload key carrying the nonce on a synthetic cron message. */
export const CRON_FIRE_NONCE_KEY = '_cronFireNonce';

/** True only for a genuine in-process cron fire (marker + matching nonce). */
export function isAuthenticCronFire(payload: { _cronFire?: unknown; [k: string]: unknown }): boolean {
  return payload._cronFire === true && payload[CRON_FIRE_NONCE_KEY] === CRON_FIRE_NONCE;
}
