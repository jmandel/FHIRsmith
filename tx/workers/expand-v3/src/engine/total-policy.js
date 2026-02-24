'use strict';

function decideTotalOutcome({
  wantPaging,
  count,
  done,
  limitedByCap,
  textFilter,
  survivors,
}) {
  const fullyEnumerated = !done && !limitedByCap;

  if (wantPaging) {
    if ((count === 0 && !limitedByCap) || fullyEnumerated) {
      return { totalStatus: 'known', total: survivors };
    }
    return { totalStatus: 'unknown', total: null };
  }

  if (limitedByCap && textFilter) {
    return { totalStatus: 'off', total: null };
  }

  return { totalStatus: 'known', total: survivors };
}

module.exports = {
  decideTotalOutcome,
};

