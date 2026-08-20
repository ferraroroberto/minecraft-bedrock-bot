// Noticing that the Realm moved between connect attempts.
//
// #42: the resolve before a kick reported region=NorthEurope; every attempt
// after it resolved to region=UAENorth and every one of those timed out without
// ever reaching spawn. The region was logged each time — but logging the same
// field repeatedly is not the same as noticing it changed, so three ~60s
// attempts burned without anyone being able to see the flip afterwards.
//
// Deliberately just an observation: this buys information, it does not steer
// retries. One incident is not enough evidence to make routing policy out of.

/**
 * Track the resolved Realm region across attempts.
 *
 * Created once per process (src/bot.js) and passed into every runSession, since
 * the whole point is comparing one attempt to the previous one.
 *
 * An unresolved region (the Realms join response carried no regionName) is not
 * a change and does not overwrite the last known one — "NorthEurope → unknown"
 * would be noise about our own parsing, not about the Realm moving.
 *
 * @returns {{ note: (region: string|null|undefined) => { changed: boolean, previous: string|null, current: string|null }, current: () => string|null }}
 */
export function createRegionWatcher() {
  let previous = null

  return {
    note(region) {
      if (region === null || region === undefined || region === '') {
        return { changed: false, previous, current: previous }
      }
      const current = String(region)
      const changed = previous !== null && previous !== current
      const wasAt = previous
      previous = current
      return { changed, previous: wasAt, current }
    },
    current: () => previous,
  }
}
