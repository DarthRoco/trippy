import { post } from './api.ts'
import { priceSymbol } from './context.ts'
import type { MapProvider, LatLng, Where, Hit } from './types.ts'

const secs = (d?: string) => (d ? parseInt(d) : 0) // "123s" -> 123
const ll = (p: LatLng) => ({ latitude: p.lat, longitude: p.lng })

// Field masks: only the fields we use (B2). They set the billed SKU (DECISIONS, day-1 check 4):
// routes = Compute Routes Pro (traffic-aware); places = Text Search Enterprise + Atmosphere (routingSummaries).
// Leg fields only: the route is stored one entry per leg. TRAFFIC_AWARE with up to 10 intermediates stays Compute
// Routes Pro (checked 2026-10-05, Routes usage-and-billing page); the field mask does not change the SKU.
const ROUTE_MASK = 'routes.legs.duration,routes.legs.distanceMeters,routes.legs.polyline.encodedPolyline,' +
  'routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction.instructions'
const NEAR_MASK = 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,' +
  'places.priceLevel,places.currentOpeningHours.openNow' // Text Search Enterprise
// primaryType (cuisine, e.g. vegetarian_restaurant) and servesVegetarianFood ride on the tier routingSummaries already sets.
const PLACES_MASK = NEAR_MASK + ',places.primaryType,places.servesVegetarianFood,routingSummaries' // Enterprise + Atmosphere
// Place Details Enterprise + Atmosphere (parkingOptions, reservable answer "parking?" and "book a table").
const DETAILS_MASK = 'displayName,formattedAddress,nationalPhoneNumber,regularOpeningHours.weekdayDescriptions,' +
  'currentOpeningHours.openNow,priceLevel,priceRange,rating,userRatingCount,websiteUri,parkingOptions,reservable'

// Drive seconds per routing leg. No duration = Google could not route there (e.g. a same-name place abroad):
// Infinity, so no time limit ever lets it through. (Reading it as 0 once let New York's 9/11 Memorial in at "0 min".)
const legsOf = (res: any, i: number): number[] =>
  (res.routingSummaries?.[i]?.legs ?? []).map((l: any) => (l.duration ? secs(l.duration) : Infinity))

const toHit = (p: any, legsSec: number[]): Hit => ({
  place_id: p.id,
  name: p.displayName?.text ?? '?',
  location: { lat: p.location.latitude, lng: p.location.longitude },
  rating: p.rating,
  reviews: p.userRatingCount,
  price: p.priceLevel?.replace('PRICE_LEVEL_', ''),
  open_now: p.currentOpeningHours?.openNow,
  type: p.primaryType,
  serves_veg: p.servesVegetarianFood,
  legsSec,
})

const where = (w: Where) => (typeof w === 'string' ? { address: w } : 'placeId' in w ? { placeId: w.placeId } : { location: { latLng: ll(w) } })

export const googleProvider: MapProvider = {
  async route(from, to) {
    const res = await post<any>('/maps/routes', {
      origin: where(from),
      destination: where(to.at(-1)!),
      intermediates: to.slice(0, -1).map(where),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      languageCode: 'en-IN', // step text otherwise follows the browser language (an Assamese one reached the model)
    }, { 'X-Goog-FieldMask': ROUTE_MASK })
    const legs = res.routes?.[0]?.legs
    if (legs?.length !== to.length) throw new Error('No route found')
    return legs.map((l: any) => ({
      polyline: l.polyline.encodedPolyline,
      duration_sec: secs(l.duration),
      distance_m: l.distanceMeters ?? 0,
      steps: (l.steps ?? []).map((s: any) => ({
        text: s.navigationInstruction?.instructions ?? '',
        km: (s.distanceMeters ?? 0) / 1000,
      })),
    }))
  },

  async searchAlongRoute(query, polyline, origin, max) {
    const res = await post<any>('/maps/places', {
      textQuery: query,
      maxResultCount: max,
      languageCode: 'en', // names in Latin script where Google has one (TESTSET #46)
      searchAlongRouteParameters: { polyline: { encodedPolyline: polyline } },
      // Same traffic model as the route, so reach and detour times are comparable (day-1 check 4).
      routingParameters: { origin: ll(origin), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' },
    }, { 'X-Goog-FieldMask': PLACES_MASK })
    return (res.places ?? []).map((p: any, i: number) =>
      toHit(p, legsOf(res, i)))
  },

  async searchNear(query, center, radiusM, max, origin) {
    const res = await post<any>('/maps/places', {
      textQuery: query,
      maxResultCount: max,
      languageCode: 'en',
      locationBias: { circle: { center: ll(center), radius: radiusM } },
      ...(origin && { routingParameters: { origin: ll(origin), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' } }),
    }, { 'X-Goog-FieldMask': origin ? PLACES_MASK : NEAR_MASK })
    return (res.places ?? []).map((p: any, i: number) =>
      toHit(p, legsOf(res, i)))
  },

  // Autocomplete (New). Biased to the given point (default Mumbai), India only.
  // ponytail: no session tokens; each call bills as one Autocomplete request (10k/month free). Add tokens if volume grows.
  async autocomplete(input, near = { lat: 19.076, lng: 72.8777 }) {
    const res = await post<any>('/maps/autocomplete', {
      input,
      includedRegionCodes: ['in'],
      locationBias: { circle: { center: ll(near), radius: 50000 } },
    }, { 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat.mainText.text,' +
      'suggestions.placePrediction.structuredFormat.secondaryText.text' })
    return (res.suggestions ?? []).filter((s: any) => s.placePrediction).map((s: any) => ({
      placeId: s.placePrediction.placeId,
      main: s.placePrediction.structuredFormat?.mainText?.text ?? '',
      secondary: s.placePrediction.structuredFormat?.secondaryText?.text ?? '',
    }))
  },

  async details(placeId) {
    const d = await post<any>('/maps/details', { id: placeId }, { 'X-Goog-FieldMask': DETAILS_MASK })
    const rupees = (p?: any) => (p?.units ? `₹${p.units}` : '')
    return {
      name: d.displayName?.text, address: d.formattedAddress, phone: d.nationalPhoneNumber,
      open_now: d.currentOpeningHours?.openNow, hours: d.regularOpeningHours?.weekdayDescriptions,
      price: priceSymbol(d.priceLevel?.replace('PRICE_LEVEL_', '')), // the model reads this result: ₹ symbols, not the enum
      price_range: d.priceRange && [rupees(d.priceRange.startPrice), rupees(d.priceRange.endPrice)].filter(Boolean).join('-'),
      rating: d.rating, reviews: d.userRatingCount, website: d.websiteUri, parking: d.parkingOptions, reservable: d.reservable,
    }
  },

  // The nearest place within radiusM (Nearby Search Pro): the name of a logged stop (#3). On the 2026-10-18 ride, distance
  // order named the stops (a hospital, a snack hotel); Google's default popularity order named a skill centre, a store.
  async nearest(center, radiusM) {
    const res = await post<any>('/maps/nearby', { maxResultCount: 1, rankPreference: 'DISTANCE',
      locationRestriction: { circle: { center: ll(center), radius: radiusM } } }, { 'X-Goog-FieldMask': 'places.id,places.displayName' })
    const p = res.places?.[0]
    return p ? { place_id: p.id, name: p.displayName?.text ?? '?' } : null
  },

  async eta(from, to, departAt) {
    const point = (p: LatLng) => ({ location: { latLng: ll(p) } })
    const res = await post<any>('/maps/routes', {
      origin: point(from), destination: point(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE',
      ...(departAt && { departureTime: departAt }), // future time -> Google's traffic forecast (G1)
    }, { 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' })
    const r = res.routes?.[0]
    if (!r) throw new Error('No route')
    return { durationSec: secs(r.duration), distanceM: r.distanceMeters }
  },
}
