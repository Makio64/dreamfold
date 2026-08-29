/**
 * Volumetric clouds, folded with the city.
 *
 * A raymarched slab of cloud, as a post pass over the scene: per pixel the ray
 * is reconstructed from the depth buffer, marched through a layer of procedural
 * density, and the accumulated light composited over whatever the scene drew —
 * so a tower pokes *through* the deck, a hazed rim fogs in front of a cloud,
 * and the sun disc dims behind one, all by transmittance rather than by a
 * sheet's alpha. The recipe is a lighter cousin of `@takram/three-clouds` from
 * the sibling project (Skybolt coverage mapping, dual-lobe Henyey–Greenstein,
 * Wrenninge multi-scatter octaves, powder, Frostbite's energy-conserving step
 * integral) — rebuilt in TSL because that library is GLSL patched through
 * onBeforeCompile, which a node material never calls.
 *
 * ## The fold
 *
 * The march happens in *bent* space — the view ray is a straight line only
 * there — and every sample is mapped back to flat space to look the density
 * up, using the closed-form inverse of `bendPosition`. Per (axis, height)
 * slice the forward map has three regions, and each inverts cleanly:
 *
 *   flat      s ≤ s0                     identity
 *   arc       0 ≤ θ ≤ curl              a circle of radius r − y around the
 *                                        roll centre C = (s0, r); given a bent
 *                                        point, θ = atan2 about C and
 *                                        y = r − |Q − C|
 *   tangent   past the curl cap          an affine frame rotated by `curl`
 *
 * The arc never reaches back over the flat zone (its image keeps s ≥ s0 for
 * any curl ≤ π), and the arc and tangent regions are mutually exclusive by
 * construction — so a bent sample decodes to at most two flat pre-images: the
 * identity branch, and one rolled branch. Both are real: a fold overlaps
 * space, and the ceiling that swings back over the street coexists with the
 * air that was already there. Their densities add.
 *
 * The light taps run through the same decode, in bent space along the world
 * sun direction — which is what lets the curled cloud ceiling cast shadow on
 * the layer under it.
 *
 * Two guards keep the inverse honest. Near zero bend the curvature is floored
 * and the decode degenerates to the identity smoothly (r grows without bound
 * and θ·r → s − s0), so the flat sky costs nothing extra in precision. And a
 * layer near the roll axis is geometrically compressed onto it — the whole
 * annulus y ≈ r maps to a line — so density fades out as y approaches r
 * rather than piling up into a bright filament along the hinge.
 *
 * ## The march is not full resolution
 *
 * Everything above is per *marched* pixel, and the march is by far the most
 * expensive thing in the frame: up to five fractal-noise evaluations per step
 * — two decoded pre-images for the sample and two more for each of the two
 * light taps — over forty steps. At a retina window that is several times the
 * cost of the entire rest of the chain put together, and it is the whole
 * reason the frame budget went. So the march renders into its own smaller
 * target, `MARCH_SCALE` of the frame, and returns the layer premultiplied:
 * radiance in rgb, transmittance in alpha. The *composite* against the scene
 * stays at full resolution, reading that layer back bilinearly — so the city
 * is never resampled, only the cloud over it is, and clouds are the one thing
 * in shot with no edge sharper than the blur passes downstream would keep
 * anyway.
 *
 * ## The post-pass camera trap
 *
 * Inside a post pass the `camera*` TSL built-ins describe the full-screen
 * quad's orthographic camera, not the scene's. Every matrix used here is
 * therefore passed in as an explicit uniform holding a live reference to the
 * scene camera's matrices, the way three's own display nodes do it, and the
 * camera position is read off the world matrix's translation column.
 */

import {
	Break, Fn, If, Loop, atan, clamp, convertToTexture, cos, dot, exp, float,
	getViewPosition, interleavedGradientNoise, length, max, min, mix,
	mx_fractal_noise_float, pow, saturate, screenCoordinate, screenUV, sin,
	smoothstep, step, uint, uniform, vec2, vec3, vec4,
} from 'three/tsl'

/**
 * The slab, in metres above the pavement. The top stays under the roll radius
 * at the house fold length (~605 m for 1900 m), because only a layer inside
 * the roll wraps with the city — see the caustic fade below for what happens
 * to the part that gets too close to the axis as the fold tightens.
 */
const CLOUD_BOTTOM = 330
const CLOUD_TOP = 700

/**
 * Field scales, in metres per feature. The weather is sized against the haze
 * window — the clouds only exist out to `fogFar`, and weather cells much
 * bigger than that window make the local sky a coin flip — and the shape and
 * detail sit at the classic ~5:1 steps below it.
 */
const WEATHER_SCALE = 1 / 4200
const SHAPE_SCALE = 1 / 950
const DETAIL_SCALE = 1 / 210
const WIND = 8
const MORPH_RATE = 0.005

/** Extinction per metre at full density; the slab is ~370 m thick. */
const SIGMA = 0.09

/**
 * The fraction of the frame the march runs at. Half in each axis is a quarter
 * of the samples, and it is the difference between the clouds costing more
 * than everything else in the chain and costing about as much as the bloom.
 * What it buys back is paid for at silhouettes — a cloud edge against a tower
 * is resolved at half a pixel of the frame — which the haze, the depth of
 * field and the tilt-shift all sit on top of. Below a half it starts to read:
 * the sun's glow through a thin deck is the first thing to go blocky.
 */
const MARCH_SCALE = 0.5

/** Primary march: exponential steps, jittered start, early exit. */
const STEPS = 40
const STEP_START = 40
const STEP_GROWTH = 1.05
const STEP_MAX = 340
const RANGE = 3400
const MIN_TRANSMITTANCE = 0.012

/**
 * The balance that decides whether the clouds read as clouds. In the sibling
 * project the sun's irradiance comes out of a physical atmosphere and simply
 * dwarfs the sky, so cloud faces render *brighter* than the blue behind them —
 * that relationship is the whole look, and a timid gain here reproduces the
 * shapes while losing it: the deck comes out as mud floating on a luminous
 * sky. The gain is therefore set so a sun-facing top clears 1.0 (and blooms),
 * and the ambient so a shadowed base still sits at most a third under the sky
 * it hangs in, with a little ground bounce lifting the undersides.
 */
const SUN_GAIN = 5
const AMBIENT_GAIN = 0.95

/**
 * Builds the cloud pass, as two nodes:
 *
 *   `layer`      the march, in its own render target at `MARCH_SCALE` — rgb is
 *                radiance already premultiplied by what it hid, alpha is the
 *                transmittance that hid it. An `RTTNode`, so the caller owns
 *                disposing it along with the rest of the chain's targets.
 *   `composite`  that layer over the scene, at full resolution.
 *
 * `color` and `depth` are the scene pass's texture nodes; `camera` is the
 * scene camera whose matrices the ray reconstruction needs.
 */
export function volumetricClouds( { color, depth }, state, sky, camera ) {

	const projectionInverse = uniform( camera.projectionMatrixInverse )
	const cameraWorld = uniform( camera.matrixWorld )

	/**
	 * Cloud density of the *flat* field at a flat plan position and height —
	 * the takram layer recipe on mx noise instead of tiled textures. `detailed`
	 * is a build-time flag: the primary march erodes edges with a second noise,
	 * the light taps skip it. The caller has already established the sample is
	 * inside the slab; this is the expensive part that gating exists to skip.
	 */
	const flatDensity = ( plan, y, detailed ) => {

		const hFrac = saturate( y.sub( CLOUD_BOTTOM ).div( CLOUD_TOP - CLOUD_BOTTOM ) )

		const wind = sky.time.mul( WIND )
		const blown = plan.add( vec2( wind, wind.mul( 0.4 ) ) )

		// Skybolt coverage: a rounded height envelope biases the weather field,
		// so coverage carves flat-bottomed, round-topped forms rather than a
		// hard threshold's terraces.
		const weather = mx_fractal_noise_float(
			vec3( blown.mul( WEATHER_SCALE ), sky.time.mul( 0.004 ) ), 3, 2, 0.6,
		).mul( 0.42 ).add( 0.5 )
		const biased = clamp( pow( hFrac, 0.35 ).mul( 2 ).sub( 1 ), - 1, 1 )
		const envelope = float( 1 ).sub( biased.mul( biased ) )
		const factor = float( 1 ).sub( sky.coverage.mul( 0.82 ).mul( envelope ) )
		const filtered = saturate( mix( weather, float( 1 ), 0.55 ).sub( factor ).div( 0.55 ) )

		// Base shape erosion: remap the coverage density from the noise floor
		// up, which eats the thin edges first.
		const shape = mx_fractal_noise_float(
			vec3( blown.x.mul( SHAPE_SCALE ), y.mul( 1 / 260 ).add( sky.time.mul( MORPH_RATE ) ), blown.y.mul( SHAPE_SCALE ) ),
			3, 2, 0.58,
		).mul( 0.5 ).add( 0.5 )
		const shapeFloor = float( 1 ).sub( shape ).mul( 0.44 )
		const carved = saturate( filtered.sub( shapeFloor ).div( float( 1 ).sub( shapeFloor ).add( 1e-4 ) ) )

		let eroded = carved
		if ( detailed ) {

			// Fluffy at the top, whispy at the bottom — the detail noise erodes
			// with a different sign at each end of the slab.
			const detail = mx_fractal_noise_float(
				vec3( blown.x.mul( DETAIL_SCALE ), y.mul( 1 / 90 ), blown.y.mul( DETAIL_SCALE ) ), 2, 2, 0.55,
			).mul( 0.5 ).add( 0.5 )
			const grain = mix( detail.mul( detail ), float( 1 ).sub( detail ), saturate( hFrac.sub( 0.2 ).mul( 5 ) ) ).mul( 0.38 )
			eroded = saturate( carved.mul( 2 ).sub( grain ).div( float( 2 ).sub( grain ) ) )

		}

		// Denser toward the top, and dissolved inside the same haze band as
		// the tiles — nothing textured may survive to the rim.
		const profile = hFrac.mul( 0.7 ).add( 0.3 )
		const reach = length( plan.sub( state.center ) )
		const hazeFade = float( 1 ).sub( smoothstep( state.fogNear, state.fogFar, reach ) )

		return eroded.mul( profile ).mul( hazeFade )

	}

	const slab = y => step( CLOUD_BOTTOM, y ).mul( step( y, CLOUD_TOP ) )

	/**
	 * Total density at a *bent* world point: decode the flat pre-images and
	 * sum them. This is where the clouds fold — the same axis machinery as
	 * `bendPosition`, run backwards. The decode itself is cheap trigonometry;
	 * the noise runs behind an in-slab gate per branch, so the many march
	 * steps that cross empty sky or street cost almost nothing.
	 */
	const bentDensity = ( position, detailed ) => {

		const plan = position.xz.sub( state.center )
		const y = position.y.sub( state.groundY )

		// The axis, chosen from the bent plan. Exact for `fold` (constant) and
		// `bowl` (the fold moves points radially, so azimuth is preserved); a
		// proxy for `double`, where the far ceiling crosses the centre plane —
		// wrong only overhead in a shape that shuts its own ceiling over it.
		const along = dot( plan, state.axis )
		const mirrored = state.axis.mul( step( 0, along ).mul( 2 ).sub( 1 ) )
		const radial = plan.add( vec2( 1e-5, 1e-5 ) ).normalize()
		const directional = mix( state.axis, mirrored, min( state.mode, 1 ) )
		const axis = mix( directional, radial, max( state.mode.sub( 1 ), 0 ) )

		const s = dot( plan, axis )
		const perpendicular = plan.sub( axis.mul( s ) )

		const k = max( state.curvature, 1e-7 )
		const r = float( 1 ).div( k )
		const hinge = state.hinge

		// The roll centre sits at (s0, r); the sample's offset from it decodes
		// the angle it was rolled through and the height it started at.
		const ds = s.sub( hinge )
		const dy = y.sub( r )
		const theta = atan( ds, r.sub( y ).add( 1e-4 ) )
		const rho = length( vec2( ds, dy ) )

		// Arc branch: unwind the circle.
		const yArc = r.sub( rho )
		const sArc = hinge.add( theta.mul( r ) )

		// Tangent branch: the straight run past the cap, in the frame rotated
		// by `curl`. Its gate is u ≥ 0 — and that legitimately includes the
		// half-turn ceiling reaching back over the flat zone.
		const eR = vec2( sin( state.curl ), cos( state.curl ).negate() )
		const eT = vec2( cos( state.curl ), sin( state.curl ) )
		const u = ds.mul( eT.x ).add( dy.mul( eT.y ) )
		const yTan = r.sub( ds.mul( eR.x ).add( dy.mul( eR.y ) ) )
		const sTan = hinge.add( state.curl.mul( r ) ).add( u )

		const onArc = step( 0, theta ).mul( step( theta, state.curl ) )
		const yBent = mix( yTan, yArc, onArc ).toVar()
		const sBent = mix( sTan, sArc, onArc )

		// The rolled branch also fades as its pre-image nears the roll axis:
		// the fold compresses the whole annulus y ≈ r onto a line there, and
		// without this the compressed layer reads as a bright filament along
		// the hinge. The flat branch must NOT get this fade — it is not
		// compressed, and killing it emptied the sky over the camera at full
		// bend.
		const axisFade = float( 1 ).sub( smoothstep( 0.55, 0.88, yBent.mul( state.curvature ) ) )
		// A shape that cuts its geometry at the vertical plane over the viewer
		// (`dream`) cuts its rolled clouds there too: the whole point of the cut
		// is that the sky behind you stays real, and a folded cloud ceiling
		// painted across it would put the dream where the shape just removed it.
		// Rolled pre-images always sit past the hinge, so the city's `along > 0`
		// term is implied and bent-space `s ≤ 0` alone marks the far side.
		const cutGate = float( 1 ).sub( state.cut.mul( step( s, 0 ) ) )
		const gateBent = mix( step( 0, u ), float( 1 ), onArc ).mul( slab( yBent ) ).mul( axisFade ).mul( cutGate )
		const gateStill = step( s, hinge ).mul( slab( y ) )

		const planBent = axis.mul( sBent ).add( perpendicular ).add( state.center ).toVar()

		const total = float( 0 ).toVar()
		If( gateBent.greaterThan( 0.002 ), () => {

			total.addAssign( flatDensity( planBent, yBent, detailed ).mul( gateBent ) )

		} )
		If( gateStill.greaterThan( 0.002 ), () => {

			total.addAssign( flatDensity( position.xz, y, detailed ).mul( gateStill ) )

		} )

		return total

	}

	/** Dual-lobe Henyey–Greenstein, anisotropy attenuated per scatter octave. */
	const phase = ( cosTheta, attenuation ) => {

		const lobe = g => {

			const gA = float( g ).mul( attenuation )
			const g2 = gA.mul( gA )
			return float( 1 ).sub( g2 )
				.div( float( 1 ).add( g2 ).sub( gA.mul( 2 ).mul( cosTheta ) ).pow( 1.5 ).mul( 4 * Math.PI ) )

		}

		return lobe( 0.7 ).add( lobe( - 0.2 ) ).mul( 0.5 )

	}

	// The march. No scene colour in here: this runs at `MARCH_SCALE` and the
	// photographs must not be resampled at that size — only the cloud is.
	const march = Fn( () => {

		const sceneDepth = depth.sample( screenUV ).r
		const viewPosition = getViewPosition( screenUV, sceneDepth, projectionInverse )
		const worldPosition = cameraWorld.mul( vec4( viewPosition, 1 ) ).xyz
		const cameraPos = cameraWorld.element( 3 ).xyz
		const toScene = worldPosition.sub( cameraPos )
		const sceneDistance = length( toScene )
		const ray = toScene.div( sceneDistance )

		const radiance = vec3( 0 ).toVar()
		const transmittance = float( 1 ).toVar()

		// A uniform branch: with the slider at zero the whole march compiles
		// away at runtime, which is why the pass needs no on/off rebuild.
		If( sky.coverage.greaterThan( 0.003 ), () => {

			const marchFar = min( sceneDistance, float( RANGE ) )
			const jitter = interleavedGradientNoise( screenCoordinate )
			const stepSize = float( STEP_START ).toVar()
			const travelled = float( 18 ).add( stepSize.mul( jitter ) ).toVar()

			const cosSun = dot( ray, sky.sunDir )

			Loop( { start: uint( 0 ), end: uint( STEPS ), type: 'uint', condition: '<' }, () => {

				If( travelled.greaterThan( marchFar ).or( transmittance.lessThan( MIN_TRANSMITTANCE ) ), () => {

					Break()

				} )

				const sample = cameraPos.add( ray.mul( travelled ) )
				const density = bentDensity( sample, true )

				If( density.greaterThan( 1e-3 ), () => {

					// Two self-shadow taps toward the sun, through the *bent*
					// field — the folded ceiling shades the layer under it.
					const shadow1 = bentDensity( sample.add( sky.sunDir.mul( 45 ) ), false )
					const shadow2 = bentDensity( sample.add( sky.sunDir.mul( 130 ) ), false )
					const opticalDepth = shadow1.mul( 80 ).add( shadow2.mul( 150 ) ).mul( SIGMA )

					// Three Wrenninge octaves: each halves the attenuation, the
					// contribution and the anisotropy of the phase.
					const sunlight = exp( opticalDepth.negate() ).mul( phase( cosSun, float( 1 ) ) )
						.add( exp( opticalDepth.negate().mul( 0.5 ) ).mul( phase( cosSun, float( 0.5 ) ) ).mul( 0.5 ) )
						.add( exp( opticalDepth.negate().mul( 0.25 ) ).mul( phase( cosSun, float( 0.25 ) ) ).mul( 0.25 ) )

					// Ambient pulled toward white rather than left at `fogColor`:
					// the swatch is a muted dusk, and a cloud lit only by it is a
					// muted cloud. The bounce term is the ground giving a little
					// of the sun back to the undersides, which is what keeps a
					// base luminous instead of sooty.
					const height = saturate( sample.y.sub( state.groundY ).sub( CLOUD_BOTTOM ).div( CLOUD_TOP - CLOUD_BOTTOM ) )
					const ambient = mix( state.fogColor, vec3( 1 ), 0.45 )
						.mul( AMBIENT_GAIN ).mul( height.mul( 0.45 ).add( 0.55 ) )
						.add( state.fogColor.mul( float( 1 ).sub( height ) ).mul( 0.16 ) )

					const extinction = density.mul( SIGMA )
					// Powder: wispy edges go dark before they go thin — kept
					// gentle, because the sky behind is bright and a heavy powder
					// rims every cloud in soot.
					const powder = float( 1 ).sub( exp( extinction.negate().mul( 150 ) ).mul( 0.5 ) )
					// A soft knee on the sun term: 1 − e^(−gain·L) climbs fast and
					// saturates, so a shadowed flank still comes up luminous while
					// a face square to the sun tops out a little over white — it
					// blooms, but bounded. The raw gain went nuclear beside the
					// disc and read as an explosion, not a cloud.
					const boosted = float( 1 ).sub( exp( sunlight.negate().mul( SUN_GAIN ) ) ).mul( 1.25 )
					const light = sky.sunColor.mul( boosted ).mul( powder ).add( ambient )

					// Frostbite's energy-conserving step: exact for a constant
					// step, so brightness does not depend on step size.
					const stepTransmit = exp( extinction.negate().mul( stepSize ) )
					radiance.addAssign( light.mul( transmittance ).mul( float( 1 ).sub( stepTransmit ) ) )
					transmittance.mulAssign( stepTransmit )

				} )

				travelled.addAssign( stepSize )
				stepSize.assign( min( stepSize.mul( STEP_GROWTH ), STEP_MAX ) )

			} )

		} )

		return vec4( radiance, transmittance )

	} )()

	const layer = convertToTexture( march ).setResolutionScale( MARCH_SCALE )

	// The composite, at full resolution. The layer arrives bilinearly
	// upsampled, and the alpha is rescaled here rather than in the march so the
	// early-exit threshold maps to fully covered — without it every thick cloud
	// keeps a one-per-cent grey veil of scene. Rescaling after the filter also
	// keeps the rescale monotonic across the interpolation, which rescaling
	// before it would not.
	const composite = Fn( () => {

		const sceneColor = color.sample( screenUV )
		const cloud = layer.sample( screenUV )
		const cover = saturate( float( 1 ).sub( cloud.a ).div( 1 - MIN_TRANSMITTANCE ) )
		return vec4( sceneColor.rgb.mul( float( 1 ).sub( cover ) ).add( cloud.rgb ), sceneColor.a )

	} )()

	return { layer, composite }

}
