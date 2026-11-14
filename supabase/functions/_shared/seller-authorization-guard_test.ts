// Tests for the seller_authorizations ownership guard.
//
// The two cases that matter are the two directions of the real incident found
// 2026-08-21: the legitimate owner must still be able to re-authorize (that is
// how an expired refresh token is replaced), and a second account must NOT be
// able to take the row (which is how one login ended up holding 1,511 of
// another user's orders).
//
// Run:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/seller-authorization-guard_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  checkSellerAuthorizationOwnership,
  ownershipConflictBody,
} from './seller-authorization-guard.ts';

const OWNER = '020dd71f-78ce-4bc2-9117-dc997c533ab9';
const OTHER = '3f0f8098-9112-43bc-941c-7795b3027296';
const SELLER = 'ASYNTH00000002';
const US = 'ATVPDKIKX0DER';

/** Fake client returning one stored row, and recording whether it was queried. */
function fakeDb(row: { user_id?: string } | null) {
  const calls: Array<Record<string, string>> = [];
  const client = {
    from(_t: string) {
      return {
        select(_c: string) {
          return {
            eq(c1: string, v1: string) {
              return {
                eq(c2: string, v2: string) {
                  return {
                    maybeSingle() {
                      calls.push({ [c1]: v1, [c2]: v2 });
                      return Promise.resolve({ data: row });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

Deno.test('DIRECTION 1: the owner re-authorizing their own account is allowed', async () => {
  const { client, calls } = fakeDb({ user_id: OWNER });
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OWNER, sellerId: SELLER, marketplaceId: US,
  });
  assertEquals(r.ok, true);
  assertEquals(r.heldBy, undefined);
  // Queried on the same key the upsert conflicts on -- not on user_id, which
  // would always match and make the guard useless.
  assertEquals(calls, [{ seller_id: SELLER, marketplace_id: US }]);
});

Deno.test('DIRECTION 2: a different user claiming the same seller is refused', async () => {
  const { client } = fakeDb({ user_id: OWNER });
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OTHER, sellerId: SELLER, marketplaceId: US,
  });
  assertEquals(r.ok, false);
  assertEquals(r.heldBy, OWNER);
});

Deno.test('a first-time connection with no existing row is allowed', async () => {
  const { client } = fakeDb(null);
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OTHER, sellerId: SELLER, marketplaceId: US,
  });
  assertEquals(r.ok, true);
});

Deno.test('a row with no user_id does not block anyone', async () => {
  // Orphaned rows exist; treating "unowned" as "owned by someone else" would
  // lock the seller out of their own account with no way back.
  const { client } = fakeDb({});
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OWNER, sellerId: SELLER, marketplaceId: US,
  });
  assertEquals(r.ok, true);
});

Deno.test("the same seller in a DIFFERENT marketplace is a separate row", async () => {
  // Held by OTHER in MX must not block OWNER in MX only because the ids match;
  // the guard keys on (seller_id, marketplace_id), exactly like the constraint.
  const { client, calls } = fakeDb({ user_id: OWNER });
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OWNER, sellerId: SELLER, marketplaceId: 'A1AM78C64UM0Y8',
  });
  assertEquals(r.ok, true);
  assertEquals(calls[0].marketplace_id, 'A1AM78C64UM0Y8');
});

Deno.test("an 'unknown' seller id is NOT guarded, and is not even queried", async () => {
  // Guarding it would let the first "unknown" row lock out every later user,
  // since they all collide on the same key. See the module header.
  const { client, calls } = fakeDb({ user_id: OWNER });
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OTHER, sellerId: 'unknown', marketplaceId: US,
  });
  assertEquals(r.ok, true);
  assertEquals(calls.length, 0);
});

Deno.test('an empty seller id is treated the same as unknown', async () => {
  const { client, calls } = fakeDb({ user_id: OWNER });
  const r = await checkSellerAuthorizationOwnership(client, {
    userId: OTHER, sellerId: '', marketplaceId: US,
  });
  assertEquals(r.ok, true);
  assertEquals(calls.length, 0);
});

Deno.test('the refusal body names the failure without leaking the other user', () => {
  const body = ownershipConflictBody(US);
  assertEquals(body.error, 'seller_account_already_linked');
  assertEquals(body.marketplace_id, US);
  // The holder's user_id must never reach the client -- it identifies another
  // customer of the platform.
  assertEquals(JSON.stringify(body).includes(OWNER), false);
});
