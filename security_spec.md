# Firestore Security Specification — BroadcastQA Studio

## 1. Data Invariants

1. **Public Non-PII Channel Catalog (`/channels/{channelKey}`)**:
   - Contains strictly broadcast channel metadata (`channelName`, optional `channelId`, `category`, optional `notes`, `visibility: "public"`, `createdByUid`, `createdAt`, `updatedAt`). Zero PII (no emails, phone numbers, or addresses).
   - `channelKey` path ID must pass `isValidId(channelKey)` (`^[a-zA-Z0-9_-]+$`, `<= 128` chars).
   - `visibility` must equal `"public"`. `allow get` and `allow list` explicitly check `existing().visibility == 'public' || isAdmin()` so no blanket read rule exists.
   - Creating a channel requires verified Google authentication (`request.auth != null && request.auth.token.email_verified == true`), strict key checks (`hasAll` + `hasOnly`), `createdByUid == request.auth.uid`, and server timestamps (`createdAt == request.time && updatedAt == request.time`).
   - Updating a channel requires `isValidChannel(incoming())`, immutable `createdByUid` and `createdAt`, `updatedAt == request.time`, explicit action allowlist via `affectedKeys().hasOnly(...)`, and identity authorization (creator or admin).
   - Deleting a channel requires `isValidId(channelKey)` and creator or admin authorization.

2. **Admin Registry (`/admins/{uid}`)**:
   - No PII stored; contains only `role: "admin"`, `grantedByUid`, `createdAt`.
   - Only the verified bootstrap administrator (`arhamshoukat4434@gmail.com` with `email_verified == true`) can create, update, or delete admin entries.
   - Users may only `get` their own `/admins/{uid}` document; `list` is denied.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)

1. **Unauthenticated Write**: Creating `/channels/ch_name_test` with `auth == null`.
2. **Unverified Email Spoofing**: Creating `/channels/ch_name_test` with `email: "arhamshoukat4434@gmail.com"` and `email_verified: false`.
3. **Identity Spoofing on Create**: Verified user `uid_a` creating `/channels/ch_name_test` with `createdByUid: "uid_b"`.
4. **Shadow Field Injection on Create**: Creating `/channels/ch_name_test` with extra ghost field `isVerified: true`.
5. **Client-Forged Timestamp on Create**: Creating `/channels/ch_name_test` with client `createdAt` not matching `request.time`.
6. **ID Poisoning**: Creating `/channels/` with a 200-character or invalid-symbol document ID (`../bad$id`).
7. **Denial-of-Wallet Oversized String**: Creating `/channels/ch_name_big` with `channelName` > 120 chars or `notes` > 500 chars.
8. **Invalid Visibility Enum**: Creating `/channels/ch_name_priv` with `visibility: "private"`.
9. **Immutable Field Tampering on Update**: Updating `/channels/ch_name_test` changing `createdByUid` or `createdAt`.
10. **Shadow Update / Value Poisoning**: Updating `/channels/ch_name_test` with `channelName: 12345` or adding ghost key `approved: true`.
11. **Unauthorized Cross-User Delete**: Non-admin user `uid_b` attempting to delete channel created by `uid_a`.
12. **Privilege Escalation on `/admins`**: Non-bootstrap user `uid_b` attempting to write `/admins/uid_b` with `{ role: "admin" }`.
