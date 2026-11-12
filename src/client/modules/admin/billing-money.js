function createAdminBillingMoney() {
  function integer(value) {
    return typeof value === 'string' && value.length <= 128 && /^-?\d+$/.test(value)
      ? BigInt(value)
      : null;
  }
  function format(value, scale = 1000000n, fallback = null) {
    const parsed = integer(value);
    if (parsed === null)
      return Number.isFinite(fallback)
        ? fallback.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) +
            ' ₽'
        : '—';
    const absolute = parsed < 0n ? -parsed : parsed,
      places = scale.toString().length - 1;
    const whole = (absolute / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    let fraction = (absolute % scale).toString().padStart(places, '0');
    while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    return (parsed < 0n ? '−' : '') + whole + ',' + fraction + ' ₽';
  }
  function difference(summary) {
    const revenue = integer(summary.netPaidKopecks ?? summary.paidRevenueKopecks),
      cost = integer(summary.providerCostMicrorub);
    return revenue !== null && cost !== null
      ? format((revenue * 10000n - cost).toString())
      : format(
          null,
          1000000n,
          Number.isFinite(summary.paidRevenueRub) && Number.isFinite(summary.providerCostRub)
            ? summary.paidRevenueRub - summary.providerCostRub
            : null,
        );
  }
  return { format, difference };
}
