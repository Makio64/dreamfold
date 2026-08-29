/**
 * Wiring only: UI ↔ world. Everything with an opinion lives on one side or the
 * other of this file.
 */

import { World } from './world/World.js'
import { SHOT_MAP } from './camera/shots.js'
import { BASE_LOOK, UI } from './ui/UI.js'
import { Recorder, downloadRecording } from './record/Recorder.js'
import {
	awaitRootTilesAuth, classifyKey, interpretTileError, rememberTileAuth,
	resolveTileAuth, verifyTileAuth,
} from './tilesAuth.js'
import './style.css'

const NO_AUTH = { key: '', kind: '', source: 'none' }

const ui = new UI()
const world = new World( document.getElementById( 'view' ) )
const recorder = new Recorder( world )

let worldReady = null
let authReady = false
let checkingKey = false
let tileAuthComplaint = false

boot()

async function boot() {

	// `resolveTileAuth` also takes a `?ion=` key back out of the address bar on
	// its way past — a credential in a URL is a credential in every referrer
	// after it.
	const auth = resolveTileAuth()
	const check = await verifyTileAuth( auth )

	// Ask before initializing, not after. The card comes up over the sky while
	// the renderer is still starting, and the gate is real: with no verified
	// token there is no auth plugin, so the tileset has no URL and nothing
	// reaches the tile service.
	// Who gets walked through where a key comes from, and who goes straight to
	// the field. `source` answers it and `key` does not: only `stored` proves
	// this browser once had a key of its own that worked, and `env` is the
	// build's own, so whoever built it knows. A `?ion=` link is somebody else's
	// key handed over; when it fails, the person holding it is starting from
	// nothing and gets both screens with the reason on the first.
	ui.on.key = onKeyEntered
	if ( ! check.ok ) {

		const known = auth.source === 'stored' || auth.source === 'env'
		ui.askForKey( auth.key ? check.reason : '', {
			invalid: Boolean( auth.key ),
			quota: Boolean( check.quota ),
			stage: known ? 'paste' : 'get',
		} )

	}

	authReady = check.ok

	worldReady = world
		.init( { onProgress: text => ui.boot( text ), auth: check.ok ? auth : NO_AUTH } )
		.then( () => true, error => {

			console.error( error )
			ui.boot( 'Could not start the renderer' )
			// The boot line sits under the setup card, so a first visit that
			// fails here would otherwise show a form and no reason.
			ui.keyNotice( 'The 3D view could not start in this browser. It needs WebGPU, or WebGL 2 as a fallback.', { invalid: true } )
			return false

		} )

	if ( ! await worldReady ) return

	world.onTileError = onTileError
	world.onFrame = onWorldFrame
	world.onStateChange = state => ui.boot( state === 'loading' ? 'Streaming the city' : '' )

	wireUI()

	addEventListener( 'resize', () => world.resize() )
	world.start()

	// Nothing of the interface appears until the tile service has answered — not
	// until the *credential checker* has. A panel of controls over a sky the
	// tiles will never reach is a set of promises the app cannot keep, and
	// `verifyTileAuth` passing is not that promise: it says the token is
	// well-formed and the endpoint knows it, while the root tileset can still
	// refuse a moment later. Revealing on the checker put "Where does it fold?"
	// on screen and *then* the setup card over the top of it, which is setup
	// arriving as an interruption rather than as the way in.
	//
	// `slow` still reveals. A timeout is not a verdict on the key, and holding
	// the interface back for a busy network is the worse failure.
	if ( check.ok && await confirmLiveTileAuth( auth, ui.keyGen ) !== 'refused' ) {

		ui.restoreLastPlace()

	}

	ui.bootDone()

}

/**
 * Google root requests are billable and uncacheable. The credential has already
 * been checked by the time it gets here; confirm it against the renderer's own
 * single root load rather than probing root.json a second time. Only a
 * credential that survives this is remembered.
 *
 * Answers with which of the three things happened, because the caller has to
 * decide whether to show the interface on the strength of it: `refused` is the
 * only one that must not.
 */
async function confirmLiveTileAuth( auth, gen ) {

	const live = await awaitRootTilesAuth( world.tiles )

	// A timeout is not a verdict on the key. The credential already passed
	// `verifyTileAuth`, and the only thing this wait proves when it expires is
	// that the root tileset is slow — a throttled tab does it every time. Real
	// rejections arrive as `load-error` and go through `onTileError`, which says
	// what actually happened. So a timeout is refused a remembered key and
	// nothing else; putting the setup card back over a working globe because the
	// network was busy is the worse failure.
	if ( live.timedOut ) {

		authReady = false
		console.warn( 'Root tileset still loading after the confirmation window; not remembering this key yet.' )
		return 'slow'

	}

	if ( ! live.ok ) {

		authReady = false
		tileAuthComplaint = false
		if ( gen === ui.keyGen ) {

			ui.askForKey( live.reason, { invalid: true } )

		}

		return 'refused'

	}

	authReady = true
	if ( auth.source === 'url' || auth.source === 'user' ) rememberTileAuth( auth )
	return 'ok'

}

/**
 * The one path a typed token takes, on a first visit and on every later
 * rejection alike: verify it, hand it to the renderer, then confirm it against
 * the live root load.
 */
async function onKeyEntered( raw ) {

	const candidate = classifyKey( raw )
	if ( ! candidate ) {

		ui.keyRejected( 'That does not look like a Cesium Ion token or a Google Maps key.' )
		return

	}

	if ( checkingKey ) return
	checkingKey = true
	ui.keyChecking( true )

	try {

		// A typed key gets the full root probe. It is worth the extra request:
		// a rejected or quota-dead key must never dispose a working tileset.
		const auth = { ...candidate, source: 'user' }
		const check = await verifyTileAuth( auth, { probeRoot: true } )
		if ( ! check.ok ) {

			ui.keyRejected( check.reason, { quota: Boolean( check.quota ) } )
			return

		}

		// Dismiss first: the confirmation below waits on the root tileset, which
		// is a long time to hold a card that has already been answered. Carry
		// the generation so a success landing after a *later* failure reopened
		// setup cannot close that one too.
		const gen = ui.keyGen
		ui.keyAccepted( gen )
		tileAuthComplaint = false

		await world.reauthorize( auth )
		// The tile renderer was rebuilt, so the frame and the destination went
		// with it — put the city back, and the pose a reload would also keep.
		if ( world.destination ) {

			const view = world.readView()
			world.setDestination( world.destination, { arrive: false } )
			world.restoreView( view )

		}

		// And on a first visit, this is where the interface arrives: after the
		// key, and after the service it unlocks has actually answered.
		if ( await confirmLiveTileAuth( auth, gen ) !== 'refused' && ! world.destination ) {

			ui.restoreLastPlace()

		}

	} catch ( error ) {

		console.error( error )
		ui.keyRejected( 'Could not use that key. Check the network and try again.' )

	} finally {

		checkingKey = false
		ui.keyChecking( false )

	}

}

/** Surfaces quota / auth failures from the live pipeline once, not per tile. */
function onTileError( event ) {

	if ( tileAuthComplaint ) return
	const interpreted = interpretTileError( event )
	if ( ! interpreted ) return

	tileAuthComplaint = true
	authReady = false
	ui.askForKey( interpreted.reason, { invalid: true, quota: Boolean( interpreted.quota ) } )

}

// ------------------------------------------------------------------ wiring

function wireUI() {

	ui.on.place = ( destination, session ) => {

		world.setDestination( destination, { arrive: ! session } )
		ui.setTrainingReady( false )
		if ( session ) {

			applySession( session )
			rememberSession()
			return

		}

		// A place chosen for one move names it, and a move carries its own
		// bending shape — so Start plays what the entry is for, and a bend
		// dragged by hand first turns around the right axis. The axis only: the
		// curl is a look, and the base look below has the last word on it just
		// as it does on the hinge. Everywhere else arrives on the plain fold and
		// keeps the move the bar was already naming, which was somebody's
		// choice rather than a property of the city they have left.
		const shot = SHOT_MAP.get( destination.move )
		if ( shot ) ui.setMove( shot.id )
		applyShape( shot?.shape || 'fold' )
		ui.setStance( 'rooftop' )
		// The base look wins over the destination's authored hinge: it is a
		// look, and looks are global here.
		applyBaseLook()
		rememberSession()

	}

	// Every control that moves the world takes it off the rails first. A shot
	// writes its channels every frame, so a manual change made underneath one
	// is silently overwritten the same tick — the bend slider springs back on
	// release and Reset is undone before it is seen.
	// The pure look ones — the sky colour and the three post toggles —
	// are not channels any shot drives, so they leave it running.
	const manual = fn => ( ...args ) => { world.stopShot(); return fn( ...args ) }

	const persist = fn => ( ...args ) => {

		const result = fn( ...args )
		rememberSession()
		return result

	}

	ui.on.bend = persist( manual( amount => world.setBend( amount ) ) )
	ui.on.shape = persist( manual( applyShape ) )
	// Choosing a move changes nothing until it is played, so this only has to
	// stop a running one — picking a different animation while one is on screen
	// and having it carry on playing the old one is the confusing half.
	ui.on.move = persist( () => world.stopShot() )
	// This edits the next run rather than the live camera. The bar is hidden
	// during playback, and World keeps the override so recording uses it too.
	ui.on.shotHeight = persist( ( id, start, finish ) =>
		world.setShotHeightRange( id, start, finish ) )
	ui.on.height = persist( manual( metres => world.rig.setHeight( metres ) ) )
	ui.on.stance = persist( manual( stance => world.setStance( stance ) ) )
	ui.on.cloudPass = persist( enabled => world.setCloudPass( enabled ) )
	ui.on.tiltShift = persist( enabled => world.setTilt( enabled ) )
	ui.on.glow = persist( enabled => world.setGlow( enabled ) )
	ui.on.sky = persist( hex => world.setSkyColor( hex ) )
	ui.on.look = persist( manual( ( key, value ) => LOOK[ key ]( value ) ) )

	// Start plays whichever of the eight the bar is naming.
	ui.on.training = active => {

		if ( active ) return world.stopShot()
		world.playShot( ui.move )

	}

	world.onShot = shot => {

		ui.setTraining( Boolean( shot ) )
		// A shot carries its own shape, and the recorder starts one without going
		// through the picker — so both readouts are written from what is actually
		// running rather than from what was last clicked.
		if ( shot ) { ui.setShape( world.fold.shape ); ui.setMove( shot.id ) }
		// A move leaves the panel wherever it finished, which is the state the
		// viewer now has in their hands.
		if ( ! shot ) {

			ui.syncLook( world.readLook() )
			rememberSession()

		}

	}

	/** Records the move the bar is naming, frame-locked. */
	ui.on.record = async running => {

		if ( running ) return recorder.cancel()

		world.stopShot()
		const shot = ui.move
		ui.setRecording( true )
		ui.boot( 'Recording — this runs slower than real time' )

		try {

			const result = await recorder.record( {
				shot,
				resolution: ui.recordValues.resolution,
				fps: ui.recordValues.fps,
				quality: ui.recordValues.quality,
				onProgress: ( { frame, totalFrames } ) => ui.setRecording( true, frame, totalFrames ),
			} )

			if ( result ) {

				downloadRecording( result, `dreamfold-${shot}` )
				ui.boot( `Saved ${result.width}×${result.height} ${result.extension.toUpperCase()}` )

			} else {

				ui.boot( '' )

			}

		} catch ( error ) {

			console.error( error )
			ui.boot( error.message || 'Recording failed' )

		} finally {

			ui.setRecording( false )
			ui.syncLook( world.readLook() )
			rememberSession()
			// Clear the line only if it is still the one this capture wrote. A
			// new destination four seconds later puts "Streaming the city" there,
			// and an unconditional timer wipes it a moment after it appears.
			const settled = ui.bootText
			setTimeout( () => { if ( ui.bootText === settled ) ui.boot( '' ) }, 4000 )

		}

	}

	ui.on.reset = persist( manual( () => {

		const destination = world.destination
		if ( ! destination ) return
		world.setBearing( destination.bearingRad )
		world.rig.setPitch( - 3 * Math.PI / 180 )
		world.rig.setGround( 0, 0 )
		world.followGround()
		world.findOpenGround()
		world.setStance( world.stance || 'rooftop' )
		ui.syncLook( world.readLook() )

	} ) )

	addEventListener( 'pagehide', flushSession )
	addEventListener( 'visibilitychange', () => {

		if ( document.visibilityState === 'hidden' ) flushSession()

	} )

}

/**
 * Pushes the panel's own values into the world.
 *
 * `LOOK_CONTROLS` carries the base look, and this is what makes it the base
 * rather than merely the *displayed* base: the world's own uniform defaults are
 * matched to it, and one wrong number in either place would otherwise leave the
 * readout and the picture disagreeing with nobody to say which was right.
 *
 * Run after `applyShape` on arrival, because a shape preset sets the curl and
 * the base has its own opinion about it. Pressing a shape button afterwards
 * still moves the curl — that is the button doing what it says. It reads
 * `BASE_LOOK` and not `ui.values` for the same reason: by this point the shape
 * has already written the live one.
 */
function applyBaseLook() {

	for ( const key in BASE_LOOK ) LOOK[ key ]( BASE_LOOK[ key ] )
	return ui.syncLook( world.readLook() )

}

/**
 * One place that turns an art-direction key into a call on the world.
 *
 * Every entry takes the raw slider number; the label and the units live in
 * `LOOK_CONTROLS`. Keeping the two apart is what lets a row be added by editing
 * one array and one line here.
 */
const LOOK = {
	foldStart: v => world.setFoldStart( v ),
	foldLength: v => world.setFoldLength( v ),
	curl: v => world.setCurl( v * Math.PI / 180 ),
	fov: v => world.setFov( v ),
	haze: v => world.setHaze( v ),
	sunAzim: v => world.setSunBearing( v ),
	sunHeight: v => world.setSunHeight( v ),
	clouds: v => world.setClouds( v ),
	tilt: v => { world.look.tilt.value = v },
	tiltBand: v => { world.look.tiltBand.value = v },
	tiltAt: v => { world.look.tiltCenter.value = v },
	vignette: v => { world.look.vignette.value = v },
	aberration: v => { world.look.aberration.value = v },
	glow: v => { world.look.glow.value = v },
	grade: v => { world.look.grade.value = v },
	exposure: v => { world.look.exposure.value = v },
	drift: v => { world.rig.sway = v },
}

/**
 * A shape button moves the curl slider with it, because it *is* a curl: `tube`
 * is the bowl stopped at a quarter turn. Leaving the readout on 180° while the
 * world stood at 90° made the slider look broken the first time it was touched.
 */
function applyShape( shape ) {

	world.setShape( shape )
	ui.setShape( world.fold.shape )
	ui.setLook( 'curl', Math.round( world.fold.curl.value * 180 / Math.PI ) )

}

/**
 * What this browser last had on screen — the city, the walk, the bar, the
 * look. Reloading used to remember only a destination id, which threw away
 * a dropped pin, a height, and whichever animation was armed.
 */
function captureSession() {

	const destination = world.destination
	if ( ! destination ) return null

	const view = world.readView()
	return {
		v: 1,
		place: {
			id: destination.id,
			lat: destination.lat,
			lon: destination.lon,
			name: destination.name,
		},
		pose: {
			x: view.x,
			z: view.z,
			yaw: view.yaw,
			pitch: view.pitch,
			height: view.height,
		},
		foldBearing: view.foldBearing,
		bend: view.bend,
		stance: ui.stance,
		shape: ui.shape,
		move: ui.move,
		shotHeights: ui.readShotHeights(),
		look: world.readLook(),
		clouds: world.cloudsEnabled,
		tilt: world.tiltEnabled,
		glow: world.glowEnabled,
		sky: world.fold.fogColor.value.getHex(),
	}

}

function applySession( session ) {

	if ( session.shape ) applyShape( session.shape )
	if ( session.move ) ui.setMove( session.move )
	if ( session.shotHeights ) {

		ui.setShotHeights( session.shotHeights )
		for ( const id in session.shotHeights ) {

			const range = session.shotHeights[ id ]
			world.setShotHeightRange( id, range.start, range.finish )

		}

	}

	if ( session.look ) {

		for ( const key in LOOK ) {

			const value = Number( session.look[ key ] )
			if ( Number.isFinite( value ) ) LOOK[ key ]( value )

		}

		ui.syncLook( world.readLook() )

	}

	if ( session.clouds !== undefined || session.tilt !== undefined || session.glow !== undefined ) {

		ui.setPassToggles( {
			clouds: session.clouds,
			tilt: session.tilt,
			glow: session.glow,
		} )
		if ( session.clouds !== undefined ) world.setCloudPass( session.clouds )
		if ( session.tilt !== undefined ) world.setTilt( session.tilt )
		if ( session.glow !== undefined ) world.setGlow( session.glow )

	}

	if ( Number.isFinite( session.sky ) ) {

		world.setSkyColor( session.sky )
		ui.setSkyHex( session.sky )

	}

	world.restoreView( {
		...session.pose,
		bend: session.bend,
		foldBearing: session.foldBearing,
		stance: session.stance,
	} )
	if ( Number.isFinite( session.bend ) ) ui.setBend( session.bend )
	if ( session.stance ) ui.setStance( session.stance )
	if ( Number.isFinite( session.pose?.height ) ) ui.setHeight( session.pose.height )

}

let sessionWrite = 0
let lastPoseKey = ''

function rememberSession() {

	clearTimeout( sessionWrite )
	sessionWrite = setTimeout( flushSession, 400 )

}

function flushSession() {

	clearTimeout( sessionWrite )
	sessionWrite = 0
	if ( ! world.destination ) return
	lastPoseKey = poseKey()
	ui.writeSession( captureSession() )

}

function poseKey() {

	const v = world.readView()
	return `${v.x.toFixed( 1 )}\t${v.z.toFixed( 1 )}\t${v.yaw.toFixed( 3 )}\t${v.pitch.toFixed( 3 )}\t${v.height.toFixed( 1 )}\t${v.bend.toFixed( 3 )}`

}

function onWorldFrame( dt ) {

	ui.setFps( dt )
	ui.setBend( world.fold.bend )
	ui.setHeight( world.rig.height )
	ui.setLoading( world.tilesLoading )
	ui.setTrainingReady( world.groundProbed )
	// Only while a shot is driving them. These DOM writes are cheap but
	// not free, and the rest of the time the panel is already the truth.
	if ( world.playing ) ui.syncLook( world.readLook() )

	const key = poseKey()
	if ( key !== lastPoseKey ) {

		lastPoseKey = key
		rememberSession()

	}

}

// A console handle, on purpose. `errorTarget` and `loaderDetail` on the world
// are the two dials worth reaching for, and `fold` is every uniform the bend
// runs on.
window.dreamfold = { world, ui, get authReady() { return authReady } }
