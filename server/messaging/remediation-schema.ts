import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 25 `pair_context_remediation`: the one-time data migration for the #61 pair-id leak,
 * the pure SQL equivalent of `remediatePairContexts(db, { confirm: true })` in
 * scripts/remediate-pair-contexts.ts (docs/MESSAGING.md, "Threads").
 *
 * While #61 was live, a message sent without context_id went to a conversation id derived only
 * from the two public agent ids (`legacyPairContextId`). For every agent pair with messages since
 * `PAIR_REMEDIATION_SINCE` under that derivable id, the pair's own messages (sender and recipient
 * both in the pair), and the wake mentions that point at them, move to the pair's stored random
 * id in `pair_contexts` (migration 19). An existing `pair_contexts` row is reused; otherwise a new
 * row gets `gen_random_uuid()`. Messages other agents sent under the same id (probes) stay.
 *
 * - The legacy id is reproduced exactly: an RFC 4122 version 5 UUID, SHA-1 over the 16 namespace
 *   bytes followed by the UTF-8 of `agent-pair:<low>:<high>`, first 16 bytes, byte 6 =
 *   (b & 0x0f) | 0x50, byte 8 = (b & 0x3f) | 0x80. Core PostgreSQL has no SHA-1 (only md5 and the
 *   SHA-2 family; pgcrypto is not loaded on PGlite), so SHA-1 is computed by a PL/pgSQL function
 *   in `pg_temp`, dropped at the end of this migration (and with the transaction on failure).
 * - The pair is ordered by code point (`COLLATE "C"`), like `pairKey` in server/messaging/service.ts
 *   and the `(low_id, high_id)` key of `pair_contexts`; agent ids are ASCII.
 * - Work is bounded: candidate rows come from `messages_owner_created` (recipient_owner_id,
 *   created_at), read with one range scan per distinct owner (a loose index scan), filtered to
 *   `created_at >= SINCE` and to version 5 UUID-shaped ids before any hashing. Moving a pair uses
 *   `messages_context_sender`; each pair is its own set of statements, like the script.
 * - Idempotent: a moved pair no longer has messages under its derivable id, so running the SQL
 *   again matches nothing. Output is one NOTICE with counts; never ids or content.
 */
export const PAIR_REMEDIATION_SINCE = 1790520360000; // 2026-09-27T14:46:00Z, scripts SINCE

/** Creates pg_temp.city_legacy_pair_id(low, high): legacyPairContextId for an ordered pair. */
export const LEGACY_PAIR_ID_FUNCTION = `
CREATE FUNCTION pg_temp.city_legacy_pair_id(low text, high text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
DECLARE
  msg bytea := decode('b6f1c1e23d4a5b6c8d9e0f1a2b3c4d5e', 'hex')
    || convert_to('agent-pair:' || low || ':' || high, 'UTF8');
  bits bigint := length(msg)::bigint * 8;
  mask constant bigint := 4294967295;
  h0 bigint := 1732584193;
  h1 bigint := 4023233417;
  h2 bigint := 2562383102;
  h3 bigint := 271733878;
  h4 bigint := 3285377520;
  w bigint[];
  a bigint; b bigint; c bigint; d bigint; e bigint; f bigint; k bigint; t bigint;
  base integer;
  uuid_bytes bytea;
BEGIN
  -- SHA-1 padding: 0x80, zeros to 56 mod 64, then the bit length as a 64-bit big-endian integer.
  msg := msg || decode('80', 'hex');
  WHILE length(msg) % 64 <> 56 LOOP
    msg := msg || decode('00', 'hex');
  END LOOP;
  msg := msg || decode(lpad(to_hex(bits), 16, '0'), 'hex');
  FOR blk IN 0 .. length(msg) / 64 - 1 LOOP
    base := blk * 64;
    w := array_fill(0::bigint, ARRAY[80], ARRAY[0]);
    FOR i IN 0 .. 15 LOOP
      w[i] := (get_byte(msg, base + i * 4)::bigint << 24)
        | (get_byte(msg, base + i * 4 + 1)::bigint << 16)
        | (get_byte(msg, base + i * 4 + 2)::bigint << 8)
        | get_byte(msg, base + i * 4 + 3)::bigint;
    END LOOP;
    FOR i IN 16 .. 79 LOOP
      t := w[i - 3] # w[i - 8] # w[i - 14] # w[i - 16];
      w[i] := ((t << 1) | (t >> 31)) & mask;
    END LOOP;
    a := h0; b := h1; c := h2; d := h3; e := h4;
    FOR i IN 0 .. 79 LOOP
      IF i < 20 THEN
        f := (b & c) | ((~b) & d); k := 1518500249;
      ELSIF i < 40 THEN
        f := b # c # d; k := 1859775393;
      ELSIF i < 60 THEN
        f := (b & c) | (b & d) | (c & d); k := 2400959708;
      ELSE
        f := b # c # d; k := 3395469782;
      END IF;
      t := ((((a << 5) | (a >> 27)) & mask) + f + e + k + w[i]) & mask;
      e := d; d := c; c := ((b << 30) | (b >> 2)) & mask; b := a; a := t;
    END LOOP;
    h0 := (h0 + a) & mask;
    h1 := (h1 + b) & mask;
    h2 := (h2 + c) & mask;
    h3 := (h3 + d) & mask;
    h4 := (h4 + e) & mask;
  END LOOP;
  -- Version 5 UUID from the first 16 digest bytes (h0..h3).
  uuid_bytes := decode(lpad(to_hex(h0), 8, '0') || lpad(to_hex(h1), 8, '0')
    || lpad(to_hex(h2), 8, '0') || lpad(to_hex(h3), 8, '0'), 'hex');
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 80);
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);
  RETURN encode(uuid_bytes, 'hex')::uuid::text;
END;
$fn$;
`;

export const pairRemediationMigration: Migration = {
  version: 25,
  name: 'pair_context_remediation',
  sql: `${LEGACY_PAIR_ID_FUNCTION}
DO $$
DECLARE
  pair record;
  target text;
  moved_messages bigint;
  moved_mentions bigint;
  pairs bigint := 0;
  total_messages bigint := 0;
  total_mentions bigint := 0;
BEGIN
  FOR pair IN
    WITH RECURSIVE owners(id) AS (
      (SELECT recipient_owner_id FROM messages ORDER BY recipient_owner_id LIMIT 1)
      UNION ALL
      SELECT (SELECT m.recipient_owner_id FROM messages m WHERE m.recipient_owner_id > o.id
               ORDER BY m.recipient_owner_id LIMIT 1)
        FROM owners o WHERE o.id IS NOT NULL
    ), recent AS (
      SELECT DISTINCT
        CASE WHEN m.sender_id COLLATE "C" < m.recipient_id COLLATE "C"
          THEN m.sender_id ELSE m.recipient_id END AS low,
        CASE WHEN m.sender_id COLLATE "C" < m.recipient_id COLLATE "C"
          THEN m.recipient_id ELSE m.sender_id END AS high,
        m.context_id
      FROM owners o
      JOIN messages m ON m.recipient_owner_id = o.id AND m.created_at >= ${PAIR_REMEDIATION_SINCE}
      WHERE o.id IS NOT NULL
        AND m.context_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    SELECT DISTINCT low, high, context_id AS legacy FROM recent
     WHERE context_id = pg_temp.city_legacy_pair_id(low, high)
     ORDER BY low, high
  LOOP
    -- Reuse the pair's stored id if the new code already created one; else store a new one.
    INSERT INTO pair_contexts(low_id, high_id, context_id, created_at)
    VALUES (pair.low, pair.high, gen_random_uuid()::text, (extract(epoch FROM now()) * 1000)::bigint)
    ON CONFLICT (low_id, high_id) DO NOTHING;
    SELECT context_id INTO STRICT target FROM pair_contexts
     WHERE low_id = pair.low AND high_id = pair.high FOR UPDATE;
    -- The pair's own messages only: others' probes under the same id are theirs.
    UPDATE mentions SET context_id = target
     WHERE source_kind = 'message' AND context_id = pair.legacy
       AND source_id IN (SELECT id::text FROM messages WHERE context_id = pair.legacy
                           AND sender_id IN (pair.low, pair.high)
                           AND recipient_id IN (pair.low, pair.high));
    GET DIAGNOSTICS moved_mentions = ROW_COUNT;
    UPDATE messages SET context_id = target
     WHERE context_id = pair.legacy
       AND sender_id IN (pair.low, pair.high) AND recipient_id IN (pair.low, pair.high);
    GET DIAGNOSTICS moved_messages = ROW_COUNT;
    IF moved_messages > 0 THEN
      pairs := pairs + 1;
      total_messages := total_messages + moved_messages;
      total_mentions := total_mentions + moved_mentions;
    END IF;
  END LOOP;
  RAISE NOTICE 'pair_context_remediation: % pairs, % messages, % mentions moved',
    pairs, total_messages, total_mentions;
END;
$$;
DROP FUNCTION pg_temp.city_legacy_pair_id(text, text);
`,
};

/** Idempotent; call before runMigrations (after the messaging and wake migrations). */
export function registerPairRemediationMigration(): void {
  registerMigration(pairRemediationMigration);
}
