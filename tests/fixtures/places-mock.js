// Fake Google Places API (New), installed before page load.
//
// index.html's Maps bootstrap loader only defines google.maps.importLibrary
// if it doesn't already exist (`d[l]?console.warn(...):d[l]=...`), so
// defining it first in an init script cleanly replaces the real API — no
// network interception needed, and nothing hits Google (whose key is
// referrer-blocked on localhost anyway).
//
// The fake implements exactly the surface openAddRestaurant() uses:
//   new AutocompleteSessionToken()
//   AutocompleteSuggestion.fetchAutocompleteSuggestions({ input, includedPrimaryTypes, sessionToken })
//     -> { suggestions: [{ placePrediction: { text: { text }, types, toPlace() } }] }
//   place.fetchFields() + displayName / formattedAddress / location.lat()/lng()
//     / internationalPhoneNumber / websiteURI / id / types / primaryType
//     / addressComponents (state + county, for the Chicagoland check)
// Like the real API, it ignores locationRestriction's exact edges — the
// app's own Illinois/county checks are what keep results in Chicagoland.
// Every place defaults to Cook County, IL unless it says otherwise.

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

// Outside Chicagoland: one across the Indiana line (its suggestion text
// isn't Illinois, so it never shows), one in Illinois but outside the
// seven metro counties (shows, but picking it is refused).
const OUT_OF_AREA_PLACES = [
  {
    id: 'mock-place-indiana', displayName: 'Mock Hoosier Grill',
    formattedAddress: '1 Mock Rd, Merrillville, IN 46410, USA', lat: 41.48, lng: -87.33,
    state: 'IN', county: 'Lake', primaryType: 'american_restaurant', types: ['american_restaurant', 'restaurant', 'food'],
  },
  {
    id: 'mock-place-rockford', displayName: 'Mock Rockford Diner',
    formattedAddress: '1 Mock St, Rockford, IL 61101, USA', lat: 42.27, lng: -89.09,
    state: 'IL', county: 'Winnebago', primaryType: 'american_restaurant', types: ['american_restaurant', 'restaurant', 'food'],
  },
];

// mode: 'ok' (default) or 'blocked' (every request rejects, like a
// referrer-blocked API key — the app should flip to manual mode and show
// its warning).
async function installPlacesMock(context, { mode = 'ok', places = SAMPLE_PLACES, addresses = SAMPLE_ADDRESSES } = {}) {
  await context.addInitScript(({ mode, places, addresses }) => {
    const toPlace = (p) => ({
      async fetchFields() { window.__placesMockFetches.push(p.id); },
      displayName: p.displayName,
      formattedAddress: p.formattedAddress,
      location: { lat: () => p.lat, lng: () => p.lng },
      internationalPhoneNumber: p.internationalPhoneNumber,
      websiteURI: p.websiteURI,
      id: p.id,
      types: p.types,
      primaryType: p.primaryType,
      addressComponents: [
        { longText: p.state === 'IN' ? 'Indiana' : 'Illinois', shortText: p.state || 'IL', types: ['administrative_area_level_1', 'political'] },
        { longText: `${p.county || 'Cook'} County`, shortText: `${p.county || 'Cook'} County`, types: ['administrative_area_level_2', 'political'] },
      ],
    });
    const toSuggestion = (p) => ({
      placePrediction: {
        text: { text: p.displayName ? `${p.displayName}, ${p.formattedAddress}` : p.formattedAddress },
        types: p.types,
        toPlace: () => toPlace(p),
      },
    });
    // Each request: { input, token } — token is the session token's id, so
    // tests can check a search's keystrokes share one billed session.
    window.__placesMockCalls = [];
    window.__placesMockFetches = [];
    let nextTokenId = 1;
    class AutocompleteSessionToken { constructor() { this.id = nextTokenId++; } }
    window.google = window.google || {};
    window.google.maps = window.google.maps || {};
    window.google.maps.importLibrary = async (lib) => {
      if (lib !== 'places') throw new Error(`places mock: unexpected library ${lib}`);
      return {
        AutocompleteSessionToken,
        AutocompleteSuggestion: {
          async fetchAutocompleteSuggestions(req) {
            window.__placesMockCalls.push({ input: req.input, token: req.sessionToken ? req.sessionToken.id : null });
            if (mode === 'blocked') throw new Error('REQUEST_DENIED (places mock)');
            const q = (req.input || '').toLowerCase();
            // Address autocomplete (manual mode) passes includedPrimaryTypes.
            if (req.includedPrimaryTypes) {
              return { suggestions: addresses.filter((a) => a.formattedAddress.toLowerCase().includes(q)).map(toSuggestion) };
            }
            return { suggestions: places.filter((p) => p.displayName.toLowerCase().includes(q)).map(toSuggestion) };
          },
        },
      };
    };
  }, { mode, places, addresses });
}

module.exports = { installPlacesMock, SAMPLE_PLACES, SAMPLE_ADDRESSES, OUT_OF_AREA_PLACES };
