// Canonical probe data for tests. Field shapes match what the app itself
// writes (see app.js: the #saveAdd handler for restaurants, the
// visits.push(...) call in openLogVisit for visits) — not guessed.

function probeRestaurants() {
  return [
    {
      id: 'probe-pizza-1',
      name: 'Probe Pizza Place',
      categories: ['Pizza', 'Italian'],
      address: '123 W Probe St, Chicago, IL 60607',
      lat: 41.8781,
      lng: -87.6298,
      phone: '+1 312-555-0101',
      website: 'https://probe-pizza.example.com',
      menu: ['Cheese Slice', 'Pepperoni Pie'],
      createdAt: Date.now() - 1000 * 60 * 60 * 24 * 400, // well outside "recently added"
    },
    {
      id: 'probe-sushi-2',
      name: 'Probe Sushi Spot',
      categories: ['Sushi', 'Japanese'],
      address: '456 N Probe Ave, Chicago, IL 60614',
      lat: 41.9153,
      lng: -87.6342,
      website: 'https://probe-sushi.example.com',
      menu: ['California Roll', 'Spicy Tuna Roll'],
      createdAt: Date.now() - 1000 * 60 * 60 * 24 * 400,
    },
    {
      id: 'probe-gem-3',
      name: 'Probe Hidden Gem',
      categories: ['Chicago Gems', 'American'],
      address: '789 S Probe Blvd, Chicago, IL 60615',
      lat: 41.7943,
      lng: -87.5907,
      menu: [],
      createdAt: Date.now(), // within "recently added" window
    },
  ];
}

function probeVisits({ authorUid = 'probe-test-uid' } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      id: 'probe-visit-1',
      restaurantId: 'probe-pizza-1',
      date: today,
      ate: ['Pepperoni Pie'],
      rating: 5,
      wouldReturn: true,
      notes: 'Great crust.',
      reviewer: 'Probe Reviewer',
      authorUid,
      createdAt: Date.now(),
    },
  ];
}

module.exports = { probeRestaurants, probeVisits };
