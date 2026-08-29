import { Euler, MathUtils, Quaternion, Vector3 } from 'three'

/**
 * The camera, in the local East-Up-South frame.
 *
 * There is no orbit here and no flight from space. The whole premise of the
 * effect is that you are *in* the city while it folds, so the rig is a head on
 * a tripod that can walk: a point above the pavement, a compass bearing, an
 * elevation, and arrow keys. That is also what makes it cheap — a camera two
 * metres off the ground only ever asks the tile pipeline for the block it is
 * standing in.
 *
 * Walking pans the whole effect: `World._followCenter` puts the fold's centre
 * on the camera every frame, so the hinge stays the same distance ahead and the
 * arc travels with the viewer. The alternative — a fold pinned to the arrival
 * coordinate — turns a walk into sliding out from under the shot, and the one
 * composition worth having is the one you are standing in.
 *
 * Two things ride on top of the pose the viewer sets:
 *
 * `foldTilt` is an additive elevation that grows with the bend. Without it the
 * shot is a fixed stare at a street while something enormous happens above the
 * frame line. It is added rather than assigned so that dragging still works
 * while the city is coming over — the viewer keeps their own bearing, and the
 * ceiling arrives in shot on its own.
 *
 * `sway` is a high-frequency camera shake, and it is translation only — side to
 * side and up and down in camera space, with nothing on any rotation axis. At
 * full fold there are no verticals left in frame, and without a moving frame of
 * reference the image reads as a photograph of a strange wall rather than as a
 * place you are standing in; but a rig that *rotates* to supply that reads as
 * the world tumbling instead of as the operator being jostled.
 */

const D2R = MathUtils.DEG2RAD

const MIN_PITCH = - 80 * D2R
const MAX_PITCH = 89 * D2R

/** Height band the slider moves through, in metres above the pavement. */
const MIN_HEIGHT = 1.6
const MAX_HEIGHT = 900

/**
 * How far from the frame origin the walk is allowed to get, in metres.
 *
 * The streaming window travels with the camera, so this is not a limit on how
 * much city there is — it is where the local frame stops being flat enough to
 * fold on. `Frame.js` treats the ENU basis as a plane, and Earth curvature
 * drops d²/2R below it: 8 cm at a kilometre, 2.8 m at six, 8 m at ten. Six
 * kilometres is a long walk and a rounding error; ten starts to be a slope.
 */
const MAX_WALK = 6000

/**
 * Walking speed, in metres a second, as a fraction of the height above the
 * pavement — so a step reads as roughly the same distance on screen whether the
 * camera is in the street or over the roofs — plus a floor for street level,
 * where a proportional speed would be a crawl.
 */
const WALK_RATE = 4.32
const WALK_FLOOR = 120
const WALK_BOOST = 4
// Ceiling on the whole thing, raised with the rest. Fast enough to cross the
// loaded disc in a few seconds, which is the trade: the tile stream cannot
// keep up with a sprint, so a long one arrives on coarse mesh and refines
// behind you. That is the intended feel — this is a camera, not a pedestrian.
const WALK_CEILING = 2640

const KEY_AXES = {
	ArrowUp: [ 0, 1 ], ArrowDown: [ 0, - 1 ], ArrowLeft: [ - 1, 0 ], ArrowRight: [ 1, 0 ],
	KeyW: [ 0, 1 ], KeyS: [ 0, - 1 ], KeyA: [ - 1, 0 ], KeyD: [ 1, 0 ],
}

const _euler = new Euler( 0, 0, 0, 'YXZ' )
const _quaternion = new Quaternion()
const _shakeOffset = new Vector3()

/**
 * A sine with an edge on it.
 *
 * Summed sines are a sway: they spend most of a stroke near the turn-around,
 * so the camera eases in and out of every excursion and the result reads as a
 * boat rather than as a rig being hit. Raising |sin| to a power below one
 * flattens the crests and steepens everything between them — same excursion,
 * crossed several times faster, turned over sharply at each end. That velocity
 * is the whole of what makes a shake feel hard; amplitude alone just makes a
 * bigger, slower float.
 */
const stroke = ( x ) => {

	const s = Math.sin( x )
	return Math.sign( s ) * Math.abs( s ) ** 0.55

}

export class Rig {

	constructor() {

		this.yaw = 0
		this.pitch = - 2 * D2R
		this.height = 160
		this.groundY = 0
		// Where the camera stands on the ground plane, in metres from the *frame*
		// origin — the fold has no fixed origin any more, it follows this. Driven
		// by the arrow keys.
		this.x = 0
		this.z = 0
		// Clearance above the pavement, set by the world's ground probe: the top
		// of whatever is standing under the camera. Held as a height rather than
		// an absolute y so it survives a moving ground datum. Zero until the probe
		// has something to say.
		this.floorHeight = 0
		// Wide. A fold is a shape that spans most of a hemisphere, and a normal
		// lens can hold either the flat street or the ceiling but not both.
		this.fov = 74

		// Additive, driven by the world from the bend amount.
		this.foldTilt = 0

		this.sway = 1
		this.swayTime = 0

		this.position = new Vector3()
		this.quaternion = new Quaternion()

		this._targetYaw = 0
		this._targetPitch = this.pitch
		this._targetHeight = this.height
		this._dragging = false
		this._pointer = { x: 0, y: 0 }
		this._element = null
		this._pointers = new Map()
		this._keys = new Set()
		this._walking = false

		// Set by `attach` so `detach` can take exactly these off again.
		this._listeners = []
		this._windowListeners = []

		this.onChange = null

	}

	/** Bearing in radians clockwise from north — the direction the lens points. */
	setBearing( bearing ) {

		this.yaw = this._targetYaw = bearing
		return this

	}

	setHeight( height, { immediate = false } = {} ) {

		this._targetHeight = MathUtils.clamp( height, MIN_HEIGHT, MAX_HEIGHT )
		if ( immediate ) this.height = this._targetHeight
		return this

	}

	setPitch( pitch, { immediate = false } = {} ) {

		this._targetPitch = MathUtils.clamp( pitch, MIN_PITCH, MAX_PITCH )
		if ( immediate ) this.pitch = this._targetPitch
		return this

	}

	update( dt ) {

		// Critically damped enough to feel like weight rather than lag. Framed
		// as a per-second retention so a dropped frame does not overshoot.
		const k = 1 - Math.exp( - dt * 9 )
		this.yaw += shortestTurn( this.yaw, this._targetYaw ) * k
		this.pitch += ( this._targetPitch - this.pitch ) * k
		this.height += ( this._targetHeight - this.height ) * ( 1 - Math.exp( - dt * 4 ) )

		this._walk( dt )
		this.swayTime += dt

	}

	/** Reads the held keys and moves along the ground plane. */
	_walk( dt ) {

		let forward = 0
		let strafe = 0
		for ( const code of this._keys ) {

			const axis = KEY_AXES[ code ]
			if ( axis ) { strafe += axis[ 0 ]; forward += axis[ 1 ] }

		}

		this._walking = forward !== 0 || strafe !== 0
		if ( ! this._walking ) return

		const boost = this._keys.has( 'ShiftLeft' ) || this._keys.has( 'ShiftRight' ) ? WALK_BOOST : 1
		const rate = Math.min( Math.max( this.height * WALK_RATE, WALK_FLOOR ) * boost, WALK_CEILING )
		const step = rate * dt
		const scale = Math.hypot( forward, strafe )

		// Along the compass bearing, not along the lens: looking up at a ceiling
		// and pressing forward should walk down the street, not into the ground.
		const sin = Math.sin( this.yaw )
		const cos = Math.cos( this.yaw )
		const east = ( forward * sin + strafe * cos ) / scale
		const south = ( - forward * cos + strafe * sin ) / scale

		this.setGround( this.x + east * step, this.z + south * step )
		if ( this.onChange ) this.onChange()

	}

	/**
	 * Moves the camera on the ground plane, held inside `MAX_WALK`.
	 *
	 * Clamped by *shortening the step* rather than by projecting the result
	 * back onto the boundary circle. Renormalising looks equivalent and is not:
	 * at the limit it turns forward motion into a full-speed orbit, because the
	 * component that ran past the edge comes back as tangential travel and the
	 * camera slides round the rim instead of stopping against it.
	 */
	setGround( x, z ) {

		const reach = Math.hypot( x, z )
		if ( reach <= MAX_WALK ) {

			this.x = x
			this.z = z
			return this

		}

		const was = Math.min( Math.hypot( this.x, this.z ), MAX_WALK )
		const dx = x - this.x
		const dz = z - this.z
		// Largest fraction of the step that stays inside the disc, solved on the
		// segment rather than on the destination.
		let lo = 0
		let hi = 1
		for ( let i = 0; i < 12; i ++ ) {

			const mid = ( lo + hi ) / 2
			if ( Math.hypot( this.x + dx * mid, this.z + dz * mid ) <= MAX_WALK ) lo = mid
			else hi = mid

		}

		this.x += dx * lo
		this.z += dz * lo
		// Degenerate case: already outside (a shot dropped us there, or MAX_WALK
		// shrank). Pull straight back in rather than freezing.
		if ( was >= MAX_WALK && lo === 0 ) {

			const now = Math.hypot( this.x, this.z ) || 1
			this.x *= MAX_WALK / now
			this.z *= MAX_WALK / now

		}

		return this

	}

	apply( camera ) {

		const t = this.swayTime
		const shake = MathUtils.clamp( this.sway / 5, 0, 1 )

		const pitch = MathUtils.clamp( this.pitch + this.foldTilt, MIN_PITCH, MAX_PITCH )

		// The frame is East-Up-South, so an unrotated camera already looks north
		// and yaw is the compass bearing outright. No shake term reaches this:
		// the lens keeps its aim exactly, and only the body of the camera moves.
		_euler.set( pitch, - this.yaw, 0 )
		_quaternion.setFromEuler( _euler )

		const above = Math.max( this.height, this.floorHeight )

		// Shake is pure camera-local translation, side to side and up and down,
		// with nothing on any rotation axis.
		//
		// Rotation is the cheap way to shake a camera and the wrong one here.
		// A roll tips the horizon, and at full fold the horizon is the only
		// thing telling you which way is up — the shot spends its whole length
		// removing every vertical from frame, so a rig that also rotates reads
		// as the *world* tumbling rather than as the operator being jostled.
		// Translation cannot be mistaken for that: it moves the camera and
		// leaves the city where it is.
		//
		// The amplitude scales with height because a fixed one is two different
		// effects. A hand's width is a shove in the street and invisible from
		// two hundred metres up, where the nearest thing in frame is a kilometre
		// away; tying it to altitude keeps the same apparent motion at both ends
		// of the crane.
		//
		// Three terms per axis, and the two that carry the stroke are squared off
		// rather than sinusoidal — a hard shake is a fast one, not only a wide
		// one. The top term is left as a plain sine and kept near 10 Hz: it is
		// the rattle that stops the big strokes reading as a float, and much
		// past that it strobes against a 60 Hz frame instead of blurring into
		// one. The two axes run on frequencies that share no common period, so
		// the pattern never settles into a diagonal.
		const reach = MathUtils.clamp( above * 0.026, 0.11, 3.2 ) * shake
		_shakeOffset.set(
			( stroke( t * 26.9 + 0.4 ) + stroke( t * 52.1 ) * 0.55
				+ Math.sin( t * 63.7 + 2.2 ) * 0.22 ) * reach,
			( stroke( t * 31.4 + 1.6 ) + stroke( t * 59.3 + 0.2 ) * 0.5
				+ Math.sin( t * 71.9 + 0.7 ) * 0.2 ) * reach * 0.7,
			0,
		)

		// Kept off the rig position so the fold centre and ground probe stay still.
		this.position.set( this.x, this.groundY + above, this.z )
		this.quaternion.copy( _quaternion )

		camera.position.copy( this.position ).add( _shakeOffset.applyQuaternion( _quaternion ) )
		camera.quaternion.copy( _quaternion )

		if ( camera.fov !== this.fov ) {

			camera.fov = this.fov
			camera.updateProjectionMatrix()

		}

		camera.updateMatrixWorld()
		return this

	}

	// ------------------------------------------------------------------ input

	attach( element ) {

		this.detach()
		this._element = element

		const add = ( type, handler, options ) => {

			element.addEventListener( type, handler, options )
			this._listeners.push( [ type, handler, options ] )

		}

		add( 'pointerdown', event => {

			this._pointers.set( event.pointerId, { x: event.clientX, y: event.clientY } )
			this._pointer.x = event.clientX
			this._pointer.y = event.clientY
			this._dragging = true
			element.setPointerCapture( event.pointerId )

		} )

		add( 'pointermove', event => {

			if ( ! this._pointers.has( event.pointerId ) ) return
			this._pointers.set( event.pointerId, { x: event.clientX, y: event.clientY } )

			// A second finger stops the look rather than starting a pinch. The
			// height is the slider's job — see the note on the wheel below —
			// and swinging the view while the second finger lands is the worst
			// of both.
			if ( this._pointers.size >= 2 ) return

			const dx = event.clientX - this._pointer.x
			const dy = event.clientY - this._pointer.y
			this._pointer.x = event.clientX
			this._pointer.y = event.clientY

			// Radians per pixel, scaled by the field of view so a narrow lens
			// does not whip. Both axes move the *world* with the pointer, which
			// is the convention every map viewer uses and the opposite of the
			// one every first-person game does.
			const rate = this.fov * D2R / Math.max( element.clientHeight, 1 )
			this._targetYaw -= dx * rate
			this._targetPitch = MathUtils.clamp( this._targetPitch + dy * rate, MIN_PITCH, MAX_PITCH )
			if ( this.onChange ) this.onChange()

		} )

		const release = event => {

			this._pointers.delete( event.pointerId )
			if ( this._pointers.size === 0 ) this._dragging = false

		}

		add( 'pointerup', release )
		add( 'pointercancel', release )

		// The wheel and the trackpad pinch do nothing to the camera, and are
		// swallowed anyway.
		//
		// They used to drive the height, which is a reasonable thing for them to
		// do and a bad thing for them to be the only way to do: a wheel over a
		// full-window canvas is also how a laptop scrolls a page and how ctrl or
		// a trackpad pinch zooms the browser, and losing the height of the shot
		// to a mistimed two-finger swipe is not a trade worth making. The slider
		// is the height control. `preventDefault` stays because letting the
		// browser zoom the interface instead would be worse than either.
		add( 'wheel', event => event.preventDefault(), { passive: false } )

		// Safari sends its own pinch events rather than a ctrl-wheel.
		for ( const type of [ 'gesturestart', 'gesturechange', 'gestureend' ] ) {

			add( type, event => event.preventDefault(), { passive: false } )

		}

		// Keys go on the window, not the canvas: the canvas is never focused,
		// and demanding a click before the arrows work is a control nobody
		// finds. The trade is that a key pressed while a slider or the search
		// box has focus has to be ignored explicitly.
		const keys = this._keys
		const typing = target => target && (
			target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
		)

		const onKeyDown = event => {

			if ( event.metaKey || event.ctrlKey || event.altKey ) return
			if ( ! KEY_AXES[ event.code ] && ! event.code.startsWith( 'Shift' ) ) return
			if ( typing( event.target ) ) return
			event.preventDefault()
			keys.add( event.code )

		}

		const onKeyUp = event => keys.delete( event.code )
		// A window that loses focus never delivers the keyup, so the camera
		// would walk away on its own and not stop.
		const onBlur = () => keys.clear()

		addEventListener( 'keydown', onKeyDown )
		addEventListener( 'keyup', onKeyUp )
		addEventListener( 'blur', onBlur )
		this._windowListeners = [
			[ 'keydown', onKeyDown ], [ 'keyup', onKeyUp ], [ 'blur', onBlur ],
		]

		return this

	}

	detach() {

		for ( const [ type, handler ] of this._windowListeners ) removeEventListener( type, handler )
		this._windowListeners.length = 0
		this._keys.clear()

		const element = this._element
		if ( ! element ) return this

		for ( const [ type, handler, options ] of this._listeners ) {

			element.removeEventListener( type, handler, options )

		}

		this._listeners.length = 0
		this._pointers.clear()
		this._element = null
		return this

	}


}

function shortestTurn( from, to ) {

	let delta = ( to - from ) % ( Math.PI * 2 )
	if ( delta > Math.PI ) delta -= Math.PI * 2
	if ( delta < - Math.PI ) delta += Math.PI * 2
	return delta

}


export { MIN_HEIGHT, MAX_HEIGHT, MAX_WALK }
