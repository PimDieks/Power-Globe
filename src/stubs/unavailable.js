// A stand-in for a library function this app never uses, which vite.config.js swaps in for the real
// one so that it stays out of the bundle. Calling it (or `new` on it) is a mistake: it says so in the
// console and throws, rather than doing nothing.
export function unavailable(name, from) {
  return function stub() {
    const message = `${name} from ${from} is not in this build (vite.config.js replaces ${from} with src/stubs/)`;
    console.error(message);
    throw new Error(message);
  };
}
