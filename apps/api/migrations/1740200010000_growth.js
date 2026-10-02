/**
 * Growth and loyalty (Phase 24).
 *
 *  - campaigns: promotions, coupons, first-ride offers, referral campaigns, win-back offers and message campaigns,
 *    each with its eligibility, offer, limits and schedule as data (the shapes are in @yatri/types growth.ts).
 *  - campaign_grants: an offer given to one person (what a new rider gets for using an invite, a win-back offer).
 *  - campaign_redemptions: a ride that used a campaign. RESERVED while the ride is open, APPLIED when it completes
 *    (the discount is worked out again on the final fare), VOID if the ride never completes. Unique per ride and
 *    campaign, so a repeat or a second instance cannot apply it twice.
 *  - reward_ledger: reward points, append-only. Earned points are lots (`remaining`) so using and expiring points is
 *    first-expiring-first; the balance is the sum of the signed `points`. A source can write a kind at most once.
 *  - referral_codes / referrals: a person's invite code and who used whose; a new rider can use one invite, once.
 *  - trips.discount_npr / trips.points_used: what the platform paid towards the fare and the points used, recorded on
 *    the ride. The fare itself is never altered (the fare engine alone prices a ride).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('PROMO', 'COUPON', 'FIRST_RIDE', 'REFERRAL', 'RETENTION', 'PUSH')),
      name text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
      description text NOT NULL DEFAULT '',
      code text CHECK (code IS NULL OR code ~ '^[A-Z0-9]{4,20}$'),
      status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED')),
      starts_at timestamptz,
      ends_at timestamptz,
      eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
      offer jsonb,
      referrer_points integer CHECK (referrer_points IS NULL OR referrer_points >= 0),
      stackable boolean NOT NULL DEFAULT false,
      per_user_limit integer CHECK (per_user_limit IS NULL OR per_user_limit >= 1),
      total_limit integer CHECK (total_limit IS NULL OR total_limit >= 1),
      valid_days_after_grant integer CHECK (valid_days_after_grant IS NULL OR valid_days_after_grant >= 1),
      message jsonb,
      sent_at timestamptz,
      version integer NOT NULL DEFAULT 1,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX campaigns_code_idx ON campaigns (code) WHERE code IS NOT NULL;
    CREATE INDEX campaigns_live_idx ON campaigns (status, kind);

    CREATE TABLE campaign_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      UNIQUE (campaign_id, user_id)
    );
    CREATE INDEX campaign_grants_user_idx ON campaign_grants (user_id);

    ALTER TABLE trips
      ADD COLUMN discount_npr integer NOT NULL DEFAULT 0 CHECK (discount_npr >= 0),
      ADD COLUMN points_used integer NOT NULL DEFAULT 0 CHECK (points_used >= 0),
      -- Set once, when the ride's offers and points were settled: a repeat (a retry, the reconcile job) changes nothing.
      ADD COLUMN rewards_settled_at timestamptz;

    CREATE TABLE campaign_redemptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
      status text NOT NULL CHECK (status IN ('RESERVED', 'APPLIED', 'VOID')),
      discount_npr integer NOT NULL DEFAULT 0 CHECK (discount_npr >= 0),
      bonus_points integer NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
      points_multiplier numeric(4, 2) NOT NULL DEFAULT 1,
      -- What the campaign said when the ride reserved it: the discount is worked out again on the final fare from THIS,
      -- so editing a campaign later never changes a ride already under way.
      name text NOT NULL,
      offer jsonb NOT NULL,
      stackable boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      applied_at timestamptz
    );
    CREATE UNIQUE INDEX campaign_redemptions_trip_idx ON campaign_redemptions (trip_id, campaign_id) WHERE trip_id IS NOT NULL;
    CREATE INDEX campaign_redemptions_campaign_idx ON campaign_redemptions (campaign_id, status);
    CREATE INDEX campaign_redemptions_user_idx ON campaign_redemptions (user_id, created_at DESC);

    CREATE TABLE reward_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('EARN', 'REDEEM', 'EXPIRE', 'ADJUST', 'REVERSAL')),
      points integer NOT NULL CHECK (points <> 0),
      remaining integer NOT NULL DEFAULT 0 CHECK (remaining >= 0),
      source text NOT NULL CHECK (source IN ('RIDE', 'CAMPAIGN', 'REFERRAL', 'ADMIN', 'EXPIRY')),
      source_id text,
      description text NOT NULL,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- A source can write a kind of entry for a person at most once: a repeated ride completion or a second server
    -- cannot pay twice. (Admin adjustments have no source id: each is its own entry.)
    CREATE UNIQUE INDEX reward_ledger_once_idx ON reward_ledger (user_id, kind, source, source_id) WHERE source_id IS NOT NULL;
    CREATE INDEX reward_ledger_user_idx ON reward_ledger (user_id, created_at DESC);
    CREATE INDEX reward_ledger_lots_idx ON reward_ledger (user_id, expires_at) WHERE kind = 'EARN' AND remaining > 0;

    CREATE TABLE referral_codes (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code text NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE referrals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referee_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'REWARDED', 'HELD')),
      created_at timestamptz NOT NULL DEFAULT now(),
      rewarded_at timestamptz,
      CHECK (referrer_id <> referee_id)
    );
    CREATE INDEX referrals_referrer_idx ON referrals (referrer_id, created_at DESC);

    INSERT INTO retention_policies (record_type, label, action, retain_days, min_retain_days, legal_basis, enforced) VALUES
      ('REWARD_LEDGER', 'Reward points history', 'KEEP', NULL, NULL,
       'A record of what riders earned and spent, kept so a balance can always be checked and explained.', false);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM retention_policies WHERE record_type = 'REWARD_LEDGER';
    DROP TABLE IF EXISTS referrals;
    DROP TABLE IF EXISTS referral_codes;
    DROP TABLE IF EXISTS reward_ledger;
    DROP TABLE IF EXISTS campaign_redemptions;
    ALTER TABLE trips DROP COLUMN IF EXISTS rewards_settled_at, DROP COLUMN IF EXISTS points_used, DROP COLUMN IF EXISTS discount_npr;
    DROP TABLE IF EXISTS campaign_grants;
    DROP TABLE IF EXISTS campaigns;
  `);
};
