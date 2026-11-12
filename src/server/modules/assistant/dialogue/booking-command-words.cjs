// Whole command words bound spoken name spans; they never broaden identity matching.
const words = new Set(
  (
    'запиши запишите запишись запишитесь ' +
    'записывай записывайте записывайся записывайтесь ' +
    'записать записаться записывать записываться запишем запишемся'
  ).split(' '),
);
function isBookingCommandWord(value) {
  return typeof value === 'string' && words.has(value.normalize('NFKC').toLowerCase());
}
module.exports = { isBookingCommandWord };
