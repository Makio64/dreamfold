/**
 * The fold.
 *
 * Everything below happens in the world frame the tiles are rendered in, which
 * `Frame.js` has already reduced to a local East-Up-South basis in metres at the
 * chosen street corner: +x east, +y up, +z south, origin on the ellipsoid under
 * the viewer. That reduction is not a convenience, it is the reason this works
 * at all — ECEF coordinates are ~6.4e6 m and a float32 vertex shader has about
 * half a metre of resolution up there. The bend needs metre-accurate geometry,
 * so the big numbers are spent once on the CPU in float64 and never reach the
 * GPU.
 *
 * ## The bend
 *
 * A cylindrical bend around a hinge line. Let `s` be the horizontal distance
 * along the fold axis, `y` the height above the pavement, `s0` the hinge, and
 * `k` the curvature in radians per metre. Ground past the hinge rolls up onto a
 * circle of radius r = 1/k tangent to it there:
 *
 *     t  = max( s - s0, 0 )      arc length spent so far
 *     θ  = k·t                   how far round the roll that point has come
 *     s' = s0 + ( r - y )·sinθ
 *     y' =      r - ( r - y )·cosθ
 *
 * θ = 0 leaves the point alone, θ = π/2 stands it on end at the horizon, θ = π
 * hangs it upside down overhead. That last one is the shot.
 *
 * The identity above is written with `r` in it for legibility only. Forming
 * r = 1/k in float32 is a trap: at the start of the animation k is ~1e-9, so r
 * is ~1e9, and `r - y` throws away every bit of the building height it was
 * meant to preserve. What the shader actually evaluates is
 *
 *     s' = s + ( t·sinθ/θ − t ) − y·sinθ
 *     y' =     t·( 1 − cosθ )/θ + y·cosθ
 *
 * the same function with r·sinθ rewritten as t·sinθ/θ and r·(1−cosθ) as
 * t·(1−cosθ)/θ. Both ratios are bounded, both go to the right limit as θ → 0,
 * and neither ever holds a number bigger than the city.
 *
 * It is also branch-free, which matters more than it looks: t = 0 collapses the
 * whole expression to (s, y), so the pavement in front of the camera comes out
 * *bit-identical*, not approximately identical. A `select` on t > 0 would put a
 * seam along the hinge in every tile that straddles it.
 *
 * ## Modes
 *
 * All three are the same bend with a different choice of axis, which is why
 * they cost the same and why crossing between them is continuous:
 *
 *   fold    axis is the authored bearing. One hinge, ahead. The Paris shot.
 *   double  axis flips with the sign of the projection: two hinges, so the
 *           street stands up at both ends and shuts overhead. Ariadne's box.
 *   bowl    axis is radial. Every direction hinges at once, so the city becomes
 *           a bowl, then a barrel, then a ceiling.
 */

import { Color } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
	Discard, Fn, cameraPosition, cos, dot, floor, length, max, min, mix, mod,
	normalize, positionLocal, positionWorld, screenCoordinate, sin, step,
	texture, uniform, uv, varying, vec2, vec3, vec4,
	modelWorldMatrix, modelWorldMatrixInverse,
} from 'three/tsl'

import { skyColor } from './sky.js'

/** Below this the two arc-length ratios are evaluated at their θ → 0 limits. */
const THETA_EPSILON = 1e-6

/**
 * Which axis the roll turns around. See the header.
 *
 * The order is load-bearing: the index *is* the uniform, and `bendPosition`
 * blends between 0, 1 and 2. Renumbering `bowl` to 1 turns every bowl into a
 * two-sided fold, so a new axis is appended and never inserted.
 */
export const FOLD_AXES = [ 'fold', 'double', 'bowl' ]

/**
 * The shapes the interface offers: an axis, a curl, and whether the geometry
 * is cut at the vertical plane over the viewer.
 *
 * Three of the five are not obvious from the axis list. `tube` is the bowl,
 * stopped at a quarter turn: the ground curls up to vertical all the way round
 * and then — because the roll is capped rather than clamped, and the arc length
 * left over runs on along the tangent — keeps going *straight up*. A bowl at
 * your feet that becomes a shaft with no ceiling, which is a very different
 * thing to stand in than a dome.
 *
 * `dream` is the fold with the cut: the ceiling comes over exactly as far as
 * your head and stops, so the sky behind you stays sky — the film's framing,
 * where the folded half hangs over the street and the world you walked in from
 * is still ordinary. The cut is also what makes a *tight* roll survivable on
 * this axis: without it the run-on carries every tall building in the
 * kilometres ahead over the top and back down through the pavement.
 *
 * `box` is one interpretation of the film's geometry rather than its shot: one
 * hinge ahead and one behind, each taken the full half turn, so the street
 * stands up at both ends and meets over the viewer. Floor, two walls and a
 * ceiling of upside-down city — and the flat blocks left broadside are the two
 * open sides of the box, which is what keeps it a street and not a barrel. It
 * cuts for the same reason `dream` does; see `foldMaterial`.
 */
export const FOLD_SHAPES = {
	fold: {
		axis: 'fold', curl: Math.PI,
		label: 'Fold', note: 'One hinge ahead of you — the street rolls up and over your head',
	},
	// The curl stops six per cent short of the half turn, and at this shape's
	// intended roll lengths that is load-bearing, not taste: at thirty metres
	// the ceiling sits at twice a ten-metre radius, so a flat lid hangs the
	// ordinary eighteen-metre roofline down to head height *everywhere*,
	// including through the lens. Stopped short, the run-on still climbs a
	// fifth of a metre per metre travelled — the folded street slopes up and
	// away over your shoulder, rooftops brushing the ground only at the crease.
	dream: {
		axis: 'fold', curl: 0.94 * Math.PI, cut: true,
		label: 'Dream', note: 'The film’s fold: the street ahead comes over and stops at your head — behind you stays real',
	},
	box: {
		axis: 'double', curl: Math.PI, cut: true,
		label: 'Box', note: 'A hinge each way — the street stands up at both ends and shuts overhead',
	},
	bowl: {
		axis: 'bowl', curl: Math.PI,
		label: 'Bowl', note: 'Every direction hinges at once and the city closes into a dish',
	},
	tube: {
		axis: 'bowl', curl: Math.PI / 2,
		label: 'Tube', note: 'The bowl stopped at a quarter turn: a shaft with no ceiling',
	},
}

/**
 * The shapes in the order the interface offers them, easiest to strangest.
 *
 * `label` and `note` live on the entry above rather than in the interface,
 * because a shape is already a thing this file defines and a second table of
 * names somewhere else is a second place to forget to edit.
 */
export const SHAPE_LIST = Object.entries( FOLD_SHAPES ).map( ( [ id, shape ] ) => ( { id, ...shape } ) )

/**
 * One set of uniforms, shared by every tile material in the scene.
 *
 * Tiles arrive and leave constantly at this altitude, so the bend has to be a
 * property of the world rather than of any mesh: a tile that streams in halfway
 * through the move gets the same node graph pointed at the same uniforms, and
 * is already folded on the first frame it is drawn.
 */
export class FoldState {

	constructor() {

		// Curvature, radians per metre. Driven through `setBend` rather than set
		// directly — the useful control is how far round the city has gone,
		// which is an angle at a distance, not a radius.
		this.curvature = uniform( 0 )

		// Where the flat ground ends, in metres from the centre along the axis.
		this.hinge = uniform( 150 )

		// Where the fold is centred on the ground plane. This tracks the camera
		// rather than the frame origin, so the hinge is always the same distance
		// in front of the viewer and walking pans the whole effect instead of
		// sliding out from under it. Every horizontal term below is measured
		// from here — including the haze, which is what keeps the rim of the
		// loaded mesh at arm's length however far the walk goes.
		this.center = uniform( vec2( 0, 0 ) )

		// Horizontal fold axis, in the local frame's xz plane.
		this.axis = uniform( vec2( 0, - 1 ) )

		// 0 = one hinge ahead, 1 = a hinge each way, 2 = radial. Held as a float
		// so the two blends in `bendPosition` can cross it continuously.
		this.mode = uniform( 0 )

		// How far round the roll is allowed to go before the rest of the arc
		// runs on straight along the tangent. Half a turn is the classic fold;
		// a quarter is a tube. It is a cap and not a clamp, which is what makes
		// the leftover continue rather than pile up at the limit.
		this.curl = uniform( Math.PI )

		// 1 stops the geometry at the vertical plane over the viewer, 0 lets
		// the run-on keep going. A property of the shape rather than of the
		// axis: `box` and `dream` set it, and `foldMaterial` explains why the
		// shapes that close low overhead cannot keep their crossed geometry.
		this.cut = uniform( 0 )

		// Pavement height in the local frame. The bend measures `y` from here,
		// so a city 80 m above the ellipsoid does not roll up around an axis
		// buried 80 m under its own streets.
		this.groundY = uniform( 0 )

		// Where the haze that hides the edge of the loaded mesh begins and ends.
		// Measured on the *unfolded* geometry — see `foldMaterial`.
		this.fogNear = uniform( 500 )
		this.fogFar = uniform( 2400 )
		this.fogColor = uniform( new Color( 0x8ea1bd ) )

		this.bend = 0
		this.shape = 'fold'

		// The distance past the hinge that "all the way over" refers to. Half a
		// turn across 1400 m is a radius of ~890 m, which puts the far side of
		// the city a comfortable few hundred metres above the lens rather than
		// scraping it.
		this.foldLength = 1400

	}

	/**
	 * `amount` is turns of the city: 0 flat, 0.5 the far edge standing vertical
	 * on the horizon, 1 the far edge inverted directly overhead.
	 */
	setBend( amount ) {

		this.bend = amount
		this.curvature.value = amount * Math.PI / this.foldLength
		return this

	}

	/**
	 * How much ground the half turn is spent over, in metres past the hinge.
	 *
	 * This and `bend` are one number to the shader — the curvature is their
	 * ratio, and nothing downstream can tell which of them moved. They are two
	 * different things to the person holding them, which is why the redundancy
	 * is kept: `bend` is the animation channel every move drives, 0 to 1, flat
	 * to fully over; this is the scale that says what "fully over" costs. Two
	 * thousand metres is a horizon coming up several streets away. Thirty is
	 * the street creasing over on a roll of radius ten and hanging its
	 * rooftops a street's height overhead — the film's own scene, and not
	 * reachable by bending harder.
	 */
	setFoldLength( metres ) {

		this.foldLength = metres
		// The curvature standing in the uniform was spent at the old length, so
		// the bend has to be re-spent at the new one; without this the roll
		// keeps the radius it had and the control does nothing until the bend
		// is next touched.
		return this.setBend( this.bend )

	}

	/**
	 * A named shape: the axis, the curl and the cut together. Setting the
	 * first two separately is still allowed — the interface exposes curl as
	 * its own slider — but every button is one of these, and the cut comes
	 * only from here: it is a property a shape declares, not a control.
	 */
	setShape( name ) {

		const shape = FOLD_SHAPES[ name ] || FOLD_SHAPES.fold
		this.shape = FOLD_SHAPES[ name ] ? name : 'fold'
		this.mode.value = Math.max( FOLD_AXES.indexOf( shape.axis ), 0 )
		this.curl.value = shape.curl
		this.cut.value = shape.cut ? 1 : 0
		return this

	}

	/** Bearing in radians, clockwise from north. */
	setBearing( bearing ) {

		// +x is east and +z is south, so a compass bearing β points along
		// ( sin β, −cos β ).
		this.axis.value.set( Math.sin( bearing ), - Math.cos( bearing ) )
		return this

	}

}

/**
 * The deformation, as a node expression over a position in the local frame.
 * Deliberately not wrapped in `Fn`: it is called once per material, the graph
 * is small, and keeping it inline lets the uniforms come in as plain properties
 * of a JS object rather than through a struct layout.
 *
 * Returns the bent position, `crossing` — the point's ground-plan coordinate
 * along its own axis after the bend, without the building-height lean — and
 * `along`, the same coordinate before it. A point has *crossed* only when the
 * two disagree in sign: on the directional axis the city behind the viewer
 * lives its whole life at negative `along`, and a cut that read `crossing`
 * alone would erase it. `foldMaterial` discards on the pair for shapes that
 * declare `cut` — see the note there for why a low ceiling cannot keep its
 * crossed geometry.
 */
export function bendPosition( position, state ) {

	const flat = vec2( position.x, position.z ).sub( state.center )
	// Natural height above the pavement. City geometry stays at one-to-one scale
	// while the camera and the fold do the moving.
	const y = position.y.sub( state.groundY )

	// The axis this point rolls around. `fold` uses the authored bearing;
	// `double` flips it behind the camera so both halves of the street rise;
	// `bowl` points it outward, which turns the single hinge into a ring.
	const along = dot( flat, state.axis )
	const mirrored = state.axis.mul( step( 0, along ).mul( 2 ).sub( 1 ) )
	// The radial axis is undefined at the origin. Anything finite will do: the
	// camera stands well inside the hinge, where t is 0 and the axis is
	// multiplied by nothing.
	const radial = normalize( flat.add( vec2( 1e-5, 1e-5 ) ) )

	const directional = mix( state.axis, mirrored, min( state.mode, 1 ) )
	const axis = mix( directional, radial, max( state.mode.sub( 1 ), 0 ) )

	const s = dot( flat, axis )
	const perpendicular = flat.sub( axis.mul( s ) )

	const t = max( s.sub( state.hinge ), 0 )
	// θ is floored, and then *everything* is evaluated at the floored angle.
	// Flooring only the denominator is the trap: sin(0)/1e-6 is 0 where the
	// limit is 1, which at zero curvature collapses the entire city onto the
	// hinge circle — a flat world that is already folded, and a very long
	// afternoon spent looking for it in the wrong file.
	const theta = max( t.mul( state.curvature ), THETA_EPSILON )

	// Ground that would roll past the curl is held there and continues along
	// the tangent instead of carrying on round. Two jobs in one expression:
	// without it the far coarse tiles, tens of kilometres out, wind three or
	// four times around the roll and come back down through the camera; and
	// with the curl brought down to a quarter turn it is what turns the bowl
	// into a tube. `ratio` splits the arc length into the part that bends and
	// the part that runs on straight, without ever dividing by the curvature:
	// under the cap it is exactly 1 and the split costs nothing.
	const capped = min( theta, state.curl )
	const ratio = capped.div( theta )
	const arc = t.mul( ratio )
	const straight = t.sub( arc )

	const sinTheta = sin( capped )
	const cosTheta = cos( capped )

	// r·sinθ and r·(1−cosθ), without ever forming r. See the header. The
	// half-angle form of 1−cosθ is not decoration: the direct subtraction
	// cancels to nothing in float32 over the first frames of the move, which is
	// exactly where a visible step would land.
	const halfSin = sin( capped.mul( 0.5 ) )
	const arcAlong = arc.mul( sinTheta.div( capped ) )
	const arcUp = arc.mul( halfSin.mul( halfSin ).mul( 2 ).div( capped ) )

	// The ground-plan part of `bentS`, kept separately as the crossing test.
	// The `y·sinθ` lean is left out on purpose: a building straddling the
	// centre plane should be cut by where it *stands*, not by where its roof
	// leans mid-roll. At t = 0 this collapses to `s` — the same value the cut
	// compares it against — so unbent ground can never disagree with itself
	// and is never touched, wherever it lies. On the directional axis `s` is
	// negative for the whole half-city behind the viewer, which is why the
	// cut needs the pair and not this value alone.
	const plan = s.add( arcAlong.sub( t ) ).add( straight.mul( cosTheta ) )
	const bentS = plan.sub( y.mul( sinTheta ) )
	const bentY = arcUp.add( y.mul( cosTheta ) ).add( straight.mul( sinTheta ) )

	const moved = perpendicular.add( axis.mul( bentS ) ).add( state.center )
	return {
		position: vec3( moved.x, bentY.add( state.groundY ), moved.y ),
		crossing: plan,
		along: s,
	}

}

/**
 * Builds the material a folded tile is drawn with.
 *
 * Unlit on purpose. Google's photorealistic mesh has the sun baked into its
 * textures — it was photographed, not authored — so any light added here is the
 * second one in the frame, and the fold makes that obvious the moment a roof
 * ends up facing down.
 *
 * `positionNode` is read back as *object* space, so the position makes a round
 * trip through the model matrix. That is only safe because of the local frame:
 * the translations are metres to a few kilometres — the walk is capped at six —
 * rather than the radius of the Earth, where float32 has half a metre of room.
 *
 * Haze is computed from the undeformed horizontal distance and carried across
 * as a varying. Fogging by distance-to-camera would undo itself exactly when it
 * is needed — folding the far edge overhead brings it to within a few hundred
 * metres of the lens, so the ragged rim where the tiles run out would sail into
 * view perfectly clear at the top of the move.
 *
 * What the haze mixes *toward* is `skyColor` sampled along the ray to the bent
 * fragment — the very function the background draws, along the very ray that
 * would reach this pixel if the tile were not there. A tile at full haze is
 * therefore identical to the sky behind it, which is what keeps the rim of the
 * loaded disc invisible at whatever elevation the fold lifts it to. The
 * clouds never complicate this: they are a raymarched pass (`clouds.js`)
 * whose density dissolves to nothing inside this same band, so nothing
 * textured is ever behind the rim. Mixing toward a flat colour — or toward a
 * *copy* of the sky — is the regression to guard against: the two drift, and
 * the rim comes back as a silhouette. See `sky.js`.
 */
export function foldMaterial( source, state, sky ) {

	const material = new MeshBasicNodeMaterial()
	material.map = source.map || null
	material.side = source.side
	material.transparent = source.transparent
	material.alphaTest = source.alphaTest
	material.vertexColors = source.vertexColors
	material.toneMapped = source.toneMapped

	const world = modelWorldMatrix.mul( vec4( positionLocal, 1 ) ).xyz
	const bent = bendPosition( world, state )
	material.positionNode = modelWorldMatrixInverse.mul( vec4( bent.position, 1 ) ).xyz

	// Distance from the fold centre, not from the frame origin: the centre is
	// the camera, so this is the ordinary distance haze it looks like — and it
	// travels with the walk instead of thinning out ahead and thickening behind.
	const radius = length( vec2( world.x, world.z ).sub( state.center ) )
	const haze = varying( radius.smoothstep( state.fogNear, state.fogFar ), 'foldHaze' )

	// A shape that declares `cut` stops its geometry at the vertical plane
	// over the viewer. Past the curl the leftover arc runs on straight — in
	// `fold` that roofs the sky behind the viewer, and in `bowl` it is the
	// dome closing, so both keep it — but a shape that brings the ceiling down
	// to tens of metres cannot: the run-on carries kilometres of horizon-grade
	// city over the top at exactly the roll height, so every building taller
	// than the ceiling comes back down *through* the pavement, and in `box` the
	// two walls' sheets cross each other and z-fight besides being coarse.
	// Cutting at the crossing means what closes overhead is only ground that
	// was ever a few hundred metres away — `box` seals as two half-lids meeting
	// in a seam at the zenith, `dream` stops at your head and leaves the sky
	// behind you real. The cut is a fragment discard rather than a vertex
	// clamp: a clamp piles the far city into the seam plane edge-on through the
	// camera, and a triangle straddling the cut still needs its near part drawn.
	// Both coordinates travel to the fragment, because crossed means the two
	// disagree: on the directional axis the city behind the viewer natively
	// lives at negative `along` and never bends, and a cut on `crossing` alone
	// erases all of it — which is most of what `dream` exists to keep.
	const crossed = varying( bent.crossing, 'foldCrossing' )
	const along = varying( bent.along, 'foldAlong' )

	// The LOD crossfade the fade plugin drives — see `NodeFadeManager`. The
	// same Bayer stipple as the plugin's own GLSL, but *always in the shader*:
	// the stock manager toggles a define on and off per fade, and under WebGPU
	// every define flip is a pipeline recompile, several per second while tiles
	// stream. At rest the uniforms sit at (1, 0), where both discards are
	// vacuously false and the whole block is a handful of dead ALU.
	const fadeIn = uniform( 1 )
	const fadeOut = uniform( 0 )
	material.fadeIn = fadeIn
	material.fadeOut = fadeOut

	// `positionWorld` is the *bent* position — `positionNode` feeds it — so this
	// is the actual ray from the lens to the pixel the fragment lands on.
	const ray = normalize( positionWorld.sub( cameraPosition ) )

	const albedo = material.map ? texture( material.map, uv() ) : vec4( 1 )
	material.colorNode = Fn( () => {

		Discard( state.cut.greaterThan( 0.5 ).and( crossed.lessThan( 0 ) ).and( along.greaterThan( 0 ) ) )

		const cell = floor( mod( screenCoordinate.xy, 4 ) )
		const half = v => mod( v.y.mul( 3 ).add( v.x.mul( 2 ) ), 4 )
		const bayer = half( mod( cell, 2 ) ).mul( 4 ).add( half( floor( cell.mul( 0.5 ) ) ) )
		const dither = bayer.add( 0.5 ).div( 16 )
		Discard( dither.greaterThanEqual( fadeIn ).or( dither.lessThan( fadeOut ) ) )

		return vec4( mix( albedo.rgb, skyColor( ray, sky ), haze ), albedo.a )

	} )()

	return material

}

/**
 * The node-material half of the LOD crossfade.
 *
 * `TilesFadePlugin` splits cleanly in two: a renderer-agnostic scheduler (which
 * tile fades which way, LRU protection, pop-when-moving-fast) and a material
 * manager that patches GLSL through `onBeforeCompile` — which a node material
 * never calls, so under WebGPU the stock plugin fails silently. This object is
 * dropped in over the plugin's `_fadeMaterialManager` and answers the same
 * three calls, driving the `fadeIn`/`fadeOut` uniforms `foldMaterial` builds
 * in. That property is private to the plugin and this is coupled to its shape
 * in 3d-tiles-renderer 0.5.1; if an upgrade breaks the seam it breaks loudly,
 * in `setFade`.
 *
 * The stock manager's `FEATURE_FADE` define is deliberately not reproduced:
 * both "complete" states collapse to the resting uniforms (1, 0), where the
 * dither discards nothing — the define only existed to strip dead code, and
 * under WebGPU flipping it costs a pipeline compile per tile per fade.
 */
export class NodeFadeManager {

	setFade( scene, fadeIn, fadeOut ) {

		if ( ! scene ) return

		// A fade is "done" at either rail; the plugin hides the object itself
		// right after, so done always displays as fully present.
		const done = ( fadeIn === 0 || fadeIn === 1 ) && ( fadeOut === 0 || fadeOut === 1 )
		scene.traverse( child => {

			const material = child.material
			if ( ! material || ! material.fadeIn ) return
			material.fadeIn.value = done ? 1 : fadeIn
			material.fadeOut.value = done ? 0 : fadeOut

		} )

	}

	// The stock manager wraps materials here; ours are born wrapped.
	prepareScene() {}

	// Disposal is `World`'s job — it owns the folding materials.
	deleteScene() {}

}

// There was a `foldPoint` here: the same bend written out longhand in float64,
// so the CPU could answer where a folded point ended up. Nothing ever called
// it. A second copy of the load-bearing arithmetic that no frame exercises is
// a copy that drifts — this one had already stopped matching the shader's
// degenerate radial case, and adding the centre offset to it was two more
// lines nobody could have noticed were wrong. The identity it spelled out is
// in the header, which is where it was actually being read from anyway.
//
// If something ever does need to fold a point on the CPU — a marker pinned to
// a roof, picking against the bent city — write it back from the header and
// give it a caller in the same commit.
