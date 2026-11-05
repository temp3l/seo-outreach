// Lightweight Node-only test guard. A caught provider error still fails the process.
let blocked = false;
const deny = () => {
  blocked = true;
  process.stderr.write('REVIEW_GUARD_BLOCKED_UNMOCKED_NETWORK\n');
  throw new Error('review_offline_network_blocked');
};
process.once('exit', () => {
  if (blocked) process.exitCode = 1;
});
const nativeFetch = globalThis.fetch;
globalThis.__webcrawlOwnedLoopbackFetch = (raw) => {
  const fixture = new URL(raw);
  if (fixture.hostname !== '127.0.0.1' || fixture.protocol !== 'http:' || fixture.pathname !== '/fixture-pagespeed') throw Error('invalid_owned_fixture');
  return (url, init) => String(url) === fixture.href ? nativeFetch(url, { ...init, redirect: 'error' }) : deny();
};
globalThis.fetch = async () => deny();
require('node:http').request = deny;
const nativeGet = require('node:http').get;
globalThis.__webcrawlOwnedPinnedGet = (raw, lookup) => {
  const fixture = new URL(raw);
  if (fixture.protocol !== 'http:' || fixture.hostname !== 'pinned-lookup.test' || !fixture.port || fixture.pathname !== '/') throw Error('invalid_owned_fixture');
  return (url, options, callback) => {
    if (String(url) !== raw) return deny();
    const guardedLookup = (host, settings, done) => lookup(host, settings, (error, address, family) => {
      if (error) return done(error);
      const addresses = Array.isArray(address) ? address.map(item => item.address) : [address];
      if (!addresses.length || addresses.some(item => item !== '127.0.0.1')) return done(new Error('owned_fixture_address_rejected'));
      done(null, address, family);
    });
    return nativeGet(url, { ...options, lookup: guardedLookup }, callback);
  };
};
require('node:http').get = deny;
require('node:https').request = deny;
require('node:https').get = deny;
