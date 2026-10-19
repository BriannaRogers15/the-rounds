// Fake Google Places API (New), installed before page load.
//
// index.html's Maps bootstrap loader only defines google.maps.importLibrary
// if it doesn't already exist (`d[l]?console.warn(...):d[l]=...`), so
// defining it first in an init script cleanly replaces the real API — no
// network interception needed, and nothing hits Google (whose key is
// referrer-blocked on localhost anyway).
//
// The fake implements exactly the surface openAddRestaurant() uses:
//   AutocompleteSuggestion.fetchAutocompleteSuggestions({ input, includedPrimaryTypes })
//     -> { suggestions: [{ placePrediction: { text: { text }, types, toPlace() } }] }
//   place.fetchFields() + displayName / formattedAddress / location.lat()/lng()
//     / internationalPhoneNumber / websiteURI / id / types / primaryType

const SAMPLE_PLACES = [
  {
    id: 'mock-place-taqueria',
    displayName: 'Mock Taqueria',
    formattedAddress: '100 W Mock St, Chicago, IL 60607, USA',
    lat: 41.8789,
    lng: -87.6359,
    internationalPhoneNumber: '+1 312-555-0199',
    websiteURI: 'https://mock-taqueria.example.com/',
    primaryType: 'mexican_restaurant',
    types: ['mexican_restaurant', 'restaurant', 'food'],
  },
  {
    // Not food/drink — the name search must filter it out client-side.
    id: 'mock-place-hardware',
    displayName: 'Mock Hardware Store',
    formattedAddress: '200 W Mock St, Chicago, IL 60607, USA',
    lat: 41.879,
    lng: -87.636,
    primaryType: 'hardware_store',
    types: ['hardware_store', 'store'],
  },
];

const SAMPLE_ADDRESSES = [
  { id: 'mock-addr-1', formattedAddress: '300 N Mock Ave, Chicago, IL 60614, USA', lat: 41.92, lng: -87.65, types: ['street_address'] },
];

// mode: 'ok' (default) or 'blocked' (every request rejects, like a
// referrer-blocked API key — the app should flip to manual mode and show
// its warning).
async function installPlacesMock(context, { mode = 'ok', places = SAMPLE_PLACES, addresses = SAMPLE_ADDRESSES } = {}) {
  await context.addInitScript(({ mode, places, addresses }) => {
    const toPlace = (p) => ({
      async fetchFields() {},
      displayName: p.displayName,
      formattedAddress: p.formattedAddress,
      location: { lat: () => p.lat, lng: () => p.lng },
      internationalPhoneNumber: p.internationalPhoneNumber,
      websiteURI: p.websiteURI,
      id: p.id,
      types: p.types,
      primaryType: p.primaryType,
    });
    const toSuggestion = (p) => ({
      placePrediction: {
        text: { text: p.displayName ? `${p.displayName}, ${p.formattedAddress}` : p.formattedAddress },
        types: p.types,
        toPlace: () => toPlace(p),
      },
    });
    window.__placesMockCalls = [];
    window.google = window.google || {};
    window.google.maps = window.google.maps || {};
    window.google.maps.importLibrary = async (lib) => {
      if (lib !== 'places') throw new Error(`places mock: unexpected library ${lib}`);
      return {
        AutocompleteSuggestion: {
          async fetchAutocompleteSuggestions(req) {
            window.__placesMockCalls.push(req.input);
            if (mode === 'blocked') throw new Error('REQUEST_DENIED (places mock)');
            // Address autocomplete (manual mode) passes includedPrimaryTypes.
            if (req.includedPrimaryTypes) return { suggestions: addresses.map(toSuggestion) };
            const q = (req.input || '').toLowerCase();
            const matches = places.filter((p) => p.displayName.toLowerCase().includes(q));
            // The startup probe searches "pizza"; answer it with everything
            // so it succeeds, same as the real API would return something.
            return { suggestions: (q === 'pizza' ? places : matches).map(toSuggestion) };
          },
        },
      };
    };
  }, { mode, places, addresses });
}

module.exports = { installPlacesMock, SAMPLE_PLACES, SAMPLE_ADDRESSES };
