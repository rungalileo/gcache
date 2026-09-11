export function emptyObservation(fixture) {
  return { ...(fixture?.observe === undefined ? {} : { events: [] }), calls: [], loaders: 0, reads: 0, writes: 0, invalidations: 0, maintenance: [],
    loads: 0, dumps: 0, policyCalls: 0, classifications: 0, comparisons: 0, sourceScopes: [], writeTtls: [], shadow: [], recovery: [] };
}
