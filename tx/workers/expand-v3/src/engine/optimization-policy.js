'use strict';

const ExpandOptimizationProfile = Object.freeze({
  DEFAULT: 'default',
  FULL: 'full',
  BASELINE: 'baseline',
  NO_PUSHDOWN: 'no-pushdown',
  NO_MEMBERSHIP: 'no-membership',
  NO_DECORATE_MANY: 'no-decorate-many',
});

function isTrue(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function normalizeProfile(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'default' || v === 'full') return ExpandOptimizationProfile.DEFAULT;
  if (v === 'baseline' || v === 'fallback' || v === 'none') return ExpandOptimizationProfile.BASELINE;
  if (v === ExpandOptimizationProfile.NO_PUSHDOWN) return ExpandOptimizationProfile.NO_PUSHDOWN;
  if (v === ExpandOptimizationProfile.NO_MEMBERSHIP) return ExpandOptimizationProfile.NO_MEMBERSHIP;
  if (v === ExpandOptimizationProfile.NO_DECORATE_MANY) return ExpandOptimizationProfile.NO_DECORATE_MANY;
  return ExpandOptimizationProfile.DEFAULT;
}

function readExpandOptimizationPolicy(params = null, env = process.env) {
  const profile = normalizeProfile(
    params?.expandOptimizationProfile
    || params?.optimizationProfile
    || env?.EXPAND_OPT_PROFILE
  );

  const policy = {
    profile,
    disablePushdown: false,
    disableMembership: false,
    disableDecorateMany: false,
  };

  if (profile === ExpandOptimizationProfile.BASELINE) {
    policy.disablePushdown = true;
    policy.disableMembership = true;
    policy.disableDecorateMany = true;
  } else if (profile === ExpandOptimizationProfile.NO_PUSHDOWN) {
    policy.disablePushdown = true;
  } else if (profile === ExpandOptimizationProfile.NO_MEMBERSHIP) {
    policy.disableMembership = true;
  } else if (profile === ExpandOptimizationProfile.NO_DECORATE_MANY) {
    policy.disableDecorateMany = true;
  }

  if (params?.disablePushdown === true || isTrue(env?.EXPAND_DISABLE_PUSHDOWN)) {
    policy.disablePushdown = true;
  }
  if (params?.disableMembership === true || isTrue(env?.EXPAND_DISABLE_MEMBERSHIP)) {
    policy.disableMembership = true;
  }
  if (params?.disableDecorateMany === true || isTrue(env?.EXPAND_DISABLE_DECORATE_MANY)) {
    policy.disableDecorateMany = true;
  }

  return policy;
}

module.exports = {
  ExpandOptimizationProfile,
  readExpandOptimizationPolicy,
};

