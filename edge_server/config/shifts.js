// =============================================================================
// SHIRO Edge Server - Nursing shifts (shift summary report, thesis section 4.7.1)
// Local times on the edge server's clock. A shift whose end is not after its
// start ends on the next day (the night shift). Change these to the ward's own
// pattern, for example 07-14, 14-21 and 21-07; the three must cover the day.
// =============================================================================

module.exports = Object.freeze([
  Object.freeze({ key: 'MORNING', label: 'Morning', start: '07:00', end: '15:00' }),
  Object.freeze({ key: 'EVENING', label: 'Evening', start: '15:00', end: '23:00' }),
  Object.freeze({ key: 'NIGHT', label: 'Night', start: '23:00', end: '07:00' })
]);
