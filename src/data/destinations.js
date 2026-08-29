/**
 * Where the city is allowed to fold.
 *
 * This is not the landmark table it grew out of. A fold is a *city* effect: the
 * shot only reads if there is dense, continuous mesh for a kilometre in every
 * direction, because that is the material the bend lifts over the viewer's head.
 * A monument on a lawn folds into a lawn. So every entry here is a block of
 * street — a grid, a boulevard, a downtown — chosen for what surrounds it
 * rather than for what stands on it.
 *
 * `groundH` + `geoidN` is the ellipsoidal height of the pavement, the same
 * correction the flight rig needs: New York, San Francisco and Chicago
 * all sit tens of metres *below* the WGS84 ellipsoid, and using the orthometric
 * height alone buries the camera. It only has to be close — `World.probeGround`
 * raycasts the loaded mesh and replaces it — but it is what places the camera
 * for the seconds before the tiles under it exist.
 *
 * `bearing` is the compass direction the camera looks on arrival, and therefore
 * the direction the fold runs. It is picked per place: down the axis of the
 * grid, so the hinge line crosses the streets square and the fold lifts whole
 * blocks rather than slicing them corner-first.
 *
 * `foldStart` is how much city stays flat in front of the viewer, in metres.
 * Wide boulevards want more — the fold should begin past the far kerb, not in
 * the middle of the road the camera is standing in.
 *
 * `move` is optional and names the shot a place was chosen for. Only one entry
 * has one: an address the film folded, which is the whole reason it is in this
 * list, and a move brings its own bending shape with it — so arriving there
 * arms the geometry the street was folded into rather than the default one.
 *
 * A verified boulevard centreline is the best opening and carries
 * `streetCenter: true`. Several older coordinates remain a park, plaza or
 * stretch of river because uncertain open ground is still safer than an address
 * inside a block: `World.probeGround` makes the surface at the coordinate a
 * floor, so an address is often a roof with a taller neighbour two metres from
 * the lens. `World.findOpenGround` can escape a roof, but only a visually checked
 * `streetCenter` coordinate is trusted for the long perspective of the shot.
 */

import { parseCoordText, parseMapLink } from './mapLinks.js'

const DEG2RAD = Math.PI / 180

/** Search form: case/accent-insensitive and indifferent to punctuation. */
export function searchKey( value ) {

	return String( value || '' )
		.normalize( 'NFD' )
		.replace( /\p{Mark}/gu, '' )
		.toLowerCase()
		.replace( /[^\p{Letter}\p{Number}]+/gu, '' )

}

export const DESTINATIONS = [

	{
		// The one everybody pictures, now placed on the centreline rather than
		// beside Palais-Royal. The avenue gives the opening a long vanishing point
		// toward the Arc and enough width to see the city begin folding past it.
		// The old id stays for browsers that already saved Paris as their last city.
		id: 'paris-rivoli', name: 'Paris', place: 'Champs-Élysées', country: 'France', cat: '🥐',
		lat: 48.87065, lon: 2.30487, groundH: 45, geoidN: 44.5,
		bearing: 293, foldStart: 620, street: 2.4, rooftop: 95,
		streetCenter: true, coverage: 'excellent',
	},
	{
		// The address the film folded: the corner of Rue César Franck and Rue
		// Bouchut, where Café Debussy was dressed into an Italian deli and where
		// Ariadne turns the street over. The coordinate is the crossing itself,
		// which is a road centreline in the same sense the other verified ones
		// are, and the quarter around it is uniform Necker Haussmann for a
		// kilometre in every direction — which is what the bend needs.
		//
		// The bearing runs west down the longer of the street's two legs: a
		// hundred metres of straight road to Rue Bellart before the axis carries
		// on over the blocks, against ninety the other way to Avenue de Saxe.
		// The street is twelve metres wide, so the flat ground in front is
		// authored short — a boulevard's six hundred metres would put the hinge
		// past everything this place is for.
		//
		// `groundH` is the probe's own answer on Google's mesh rather than a
		// map's: the placeholder only has to hold the camera up for the seconds
		// before the tiles arrive, and it is the mesh those seconds end on.
		id: 'paris-cesar-franck', name: 'Paris', place: 'Rue César Franck', country: 'France', cat: '🌀',
		lat: 48.84733, lon: 2.30977, groundH: 35, geoidN: 44.5,
		bearing: 250, foldStart: 380, street: 2.4, rooftop: 90,
		streetCenter: true, move: 'dream', coverage: 'excellent',
	},
	{
		// Bryant Park, not an address on the avenue. The only entry where the
		// fold has to lift towers rather than a roofline — 300 m of building
		// bends far more visibly than 30 m does — and the lawn is what makes it
		// watchable: an origin inside a Midtown block puts the lens against the
		// neighbouring curtain wall and there is no shot at all.
		id: 'nyc-midtown', name: 'New York', place: 'Bryant Park', country: 'United States', cat: '🗽',
		lat: 40.75365, lon: -73.9833, groundH: 16, geoidN: -32.5,
		// up 7th Avenue: the avenues run the long axis of the grid
		bearing: 29, foldStart: 600, street: 2.6, rooftop: 240, coverage: 'excellent',
	},
	{
		id: 'tokyo-shibuya', name: 'Tokyo', place: 'Shibuya', country: 'Japan', cat: '🏮',
		lat: 35.65947, lon: 139.70057, groundH: 24, geoidN: 37,
		bearing: 22, foldStart: 500, street: 2.4, rooftop: 120, coverage: 'excellent',
	},
	{
		// Eixample. Cerdà's 133 m octagonal blocks are the most fold-friendly
		// street pattern on Earth: perfectly periodic, so the bend reads as a
		// bend and not as terrain.
		id: 'barcelona-eixample', name: 'Barcelona', place: 'Eixample', country: 'Spain', cat: '🟧',
		lat: 41.39395, lon: 2.16177, groundH: 30, geoidN: 49.5,
		// along the Diagonal's grain, 45° to the block grid
		bearing: 45, foldStart: 540, street: 2.4, rooftop: 90, coverage: 'excellent',
	},
	{
		// From the river at London Bridge, looking back over the City. Open
		// water for the near ground and the whole cluster past the hinge.
		id: 'london-city', name: 'London', place: 'The Thames', country: 'United Kingdom', cat: '🎡',
		lat: 51.5078, lon: -0.0876, groundH: 15, geoidN: 46.5,
		bearing: 250, foldStart: 520, street: 2.4, rooftop: 140, coverage: 'excellent',
	},
	{
		// The river at Michigan Avenue. Dense, tall, and the grid is square to
		// the lake, so a fold along either axis lands clean.
		id: 'chicago-loop', name: 'Chicago', place: 'Chicago River', country: 'United States', cat: '🌆',
		lat: 41.8878, lon: -87.624, groundH: 181, geoidN: -34,
		bearing: 180, foldStart: 600, street: 2.6, rooftop: 220, coverage: 'excellent',
	},
	{
		id: 'sf-financial', name: 'San Francisco', place: 'The Embarcadero', country: 'United States', cat: '🌉',
		lat: 37.7942, lon: -122.3953, groundH: 20, geoidN: -32.5,
		bearing: 58, foldStart: 540, street: 2.6, rooftop: 180, coverage: 'excellent',
	},
	{
		id: 'hongkong-central', name: 'Hong Kong', place: 'Central waterfront', country: 'Hong Kong', cat: '🏙️',
		lat: 22.2843, lon: 114.1596, groundH: 8, geoidN: 2,
		// toward the Peak, so the fold takes the hillside up with the towers
		bearing: 200, foldStart: 480, street: 2.6, rooftop: 190, coverage: 'good',
	},
	{
		id: 'sydney-cbd', name: 'Sydney', place: 'Hyde Park', country: 'Australia', cat: '🎭',
		lat: -33.8718, lon: 151.2116, groundH: 25, geoidN: 22,
		bearing: 350, foldStart: 520, street: 2.4, rooftop: 160, coverage: 'excellent',
	},
	{
		id: 'toronto-downtown', name: 'Toronto', place: 'Roundhouse Park', country: 'Canada', cat: '🍁',
		lat: 43.6426, lon: -79.3818, groundH: 80, geoidN: -36,
		bearing: 12, foldStart: 560, street: 2.5, rooftop: 200, coverage: 'excellent',
	},
	{
		id: 'amsterdam-canals', name: 'Amsterdam', place: 'Grachtengordel', country: 'Netherlands', cat: '🚲',
		lat: 52.36780, lon: 4.88600, groundH: 1, geoidN: 44,
		// along the Herengracht, so the canal folds with the houses
		bearing: 33, foldStart: 460, street: 2.3, rooftop: 70, coverage: 'excellent',
	},
	{
		id: 'lisbon-baixa', name: 'Lisbon', place: 'Baixa Pombalina', country: 'Portugal', cat: '🚋',
		lat: 38.71080, lon: -9.13800, groundH: 12, geoidN: 53,
		bearing: 350, foldStart: 480, street: 2.3, rooftop: 80, coverage: 'excellent',
	},
	{
		id: 'melbourne-cbd', name: 'Melbourne', place: 'The Yarra', country: 'Australia', cat: '☕',
		lat: -37.8183, lon: 144.969, groundH: 15, geoidN: 5,
		bearing: 232, foldStart: 540, street: 2.5, rooftop: 175, coverage: 'excellent',
	},
	{
		id: 'venice-sanmarco', name: 'Venice', place: 'San Marco', country: 'Italy', cat: '🛶',
		lat: 45.43430, lon: 12.33840, groundH: 2, geoidN: 47,
		// across the basin toward the Salute — the lagoon folding up is worth
		// the thinner roof mesh
		bearing: 200, foldStart: 500, street: 2.2, rooftop: 65, coverage: 'good',
	},

]

export const DESTINATION_MAP = new Map( DESTINATIONS.map( d => [ d.id, d ] ) )

/** Everything the world needs, in the units it works in. */
export function resolveDestination( source ) {

	const groundH = source.groundH ?? 0
	const geoidN = source.geoidN ?? 0

	return {
		...source,
		latRad: source.lat * DEG2RAD,
		lonRad: source.lon * DEG2RAD,
		// ellipsoidal height of the pavement — the number the ellipsoid speaks
		groundHeight: groundH + geoidN,
		bearingRad: ( source.bearing ?? 0 ) * DEG2RAD,
		foldStart: source.foldStart ?? 540,
		street: source.street ?? 2.5,
		rooftop: source.rooftop ?? 160,
	}

}

/**
 * Resolves free text to a destination — a name, a coordinate pair, or a link
 * pasted out of any of the map services `parseMapLink` reads.
 *
 * Always answers with an object, never null: `destination` is the place,
 * `source` names where the coordinate was found so the interface can confirm
 * it, and `reason` is the sentence to show when there is nothing to fold.
 */
export function parseLocation( input ) {

	const text = String( input || '' ).trim()
	if ( ! text ) return {}

	const link = parseMapLink( text )
	if ( link ) {

		if ( link.lat !== undefined ) {

			const destination = coordDestination( link.lat, link.lon, { name: link.label } )
			return destination
				? { destination, source: link.source }
				: { reason: 'That URL points off the globe' }

		}

		const named = link.label && findDestination( link.label )
		if ( named ) return { destination: named, source: link.source }

		return { source: link.source, reason: link.reason || `No coordinate in that ${link.source} URL` }

	}

	const point = parseCoordText( text )
	if ( point ) return { destination: coordDestination( point.lat, point.lon ) }

	// numbers and hemispheres and nothing else: they meant a coordinate, and the
	// only thing wrong with it is the range
	if ( /\d/.test( text ) && /^[-+\d.,;:/\s°'′"″NSEWnsew]+$/.test( text ) ) {

		return { reason: 'Latitude runs −90…90 and longitude −180…180' }

	}

	const hit = findDestination( text )
	return hit
		? { destination: hit }
		: { reason: 'Nothing found — paste a Google Maps URL, or try 48.8634, 2.3365' }

}

/**
 * A prefix beats a mention: "Paris" is the city before it is a word inside
 * another entry's fields, so a plain `includes` scan would answer with
 * whichever of the two happens to sit higher in the list.
 */
function findDestination( input ) {

	const needle = searchKey( input )
	if ( ! needle ) return null

	const fields = d => [ d.name, d.place, d.country ].map( searchKey )
	return DESTINATIONS.find( d => fields( d ).some( f => f.startsWith( needle ) ) )
		|| DESTINATIONS.find( d => fields( d ).some( f => f.includes( needle ) ) )
		|| null

}

export function coordDestination( lat, lon, { name } = {} ) {

	if ( ! isFinite( lat ) || ! isFinite( lon ) ) return null
	if ( Math.abs( lat ) > 90 || Math.abs( lon ) > 180 ) return null

	return {
		id: 'custom',
		// a shared link often names the place it points at, and that name is a
		// better label than "Dropped pin"
		name: name || 'Dropped pin',
		place: formatCoord( lat, lon ),
		country: '',
		cat: '📍',
		lat, lon,
		// no elevation data for an arbitrary point; the ground probe fixes it up
		// once the tiles under it have loaded
		groundH: 0, geoidN: 0,
		bearing: 0, foldStart: 540, street: 2.5, rooftop: 150,
		coverage: 'unknown',
	}

}

export function formatCoord( lat, lon ) {

	const ns = lat >= 0 ? 'N' : 'S'
	const ew = lon >= 0 ? 'E' : 'W'
	return `${Math.abs( lat ).toFixed( 4 )}° ${ns}   ${Math.abs( lon ).toFixed( 4 )}° ${ew}`

}
