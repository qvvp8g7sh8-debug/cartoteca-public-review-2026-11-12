const os = require('node:os'),
  net = require('node:net');
function privateRanges() {
  const ranges = new net.BlockList();
  ranges.addSubnet('10.0.0.0', 8);
  ranges.addSubnet('172.16.0.0', 12);
  ranges.addSubnet('192.168.0.0', 16);
  return ranges;
}
function localOrigins(values = []) {
  if (!Array.isArray(values) || values.length > 8) throw Error('Некорректные локальные адреса.');
  const ranges = privateRanges();
  return [
    ...new Set(
      values.map((value) => {
        const url = new URL(value);
        if (
          url.origin !== value ||
          url.protocol !== 'http:' ||
          !net.isIPv4(url.hostname) ||
          !ranges.check(url.hostname)
        )
          throw Error('Wi-Fi требует точного HTTP-адреса с частным IPv4.');
        return url.origin;
      }),
    ),
  ];
}
function wifiAddress(
  interfaces = os.networkInterfaces(),
  name = process.env.WIFI_INTERFACE || 'Wi-Fi',
) {
  const address = interfaces[name]?.find((a) => a.family === 'IPv4' && !a.internal);
  if (!address) throw Error(`Нет IPv4 у адаптера «${name}». Подключите Wi-Fi и запустите снова.`);
  if (!net.isIPv4(address.address) || !privateRanges().check(address.address))
    throw Error('Для просмотра нужен частный IPv4 Wi-Fi.');
  if (!net.isIPv4(address.netmask))
    throw Error('Не удалось безопасно определить локальную подсеть.');
  const mask = address.netmask.split('.').map(Number),
    bits = mask.map((n) => n.toString(2).padStart(8, '0')).join('');
  if (!/^1{8,30}0+$/.test(bits)) throw Error('Не удалось безопасно определить локальную подсеть.');
  return {
    name,
    address: address.address,
    subnet: address.address
      .split('.')
      .map((n, i) => Number(n) & mask[i])
      .join('.'),
    prefix: bits.indexOf('0'),
  };
}
module.exports = { wifiAddress, localOrigins };
