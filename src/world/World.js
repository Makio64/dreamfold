import {
	MathUtils, NeutralToneMapping, PerspectiveCamera, Raycaster, Scene, SRGBColorSpace, Vector3,
} from 'three'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'
import {
	abs, convertToTexture, dot, float, length, max, mix, pass,
	positionWorldDirection, screenSize, screenUV, smoothstep, uniform, vec2,
	vec3, vec4,
} from 'three/tsl'
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'

import { TilesRenderer } from '3d-tiles-renderer'
import { CesiumIonAuthPlugin, GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins'
import { GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins'

import { Frame } from './Frame.js'
import { FoldState, NodeFadeManager, foldMaterial } from './fold.js'
import { SkyState, skyColor } from './sky.js'
import { volumetricClouds } from './clouds.js'
import { MAX_HEIGHT, MIN_HEIGHT, Rig } from '../camera/Rig.js'
import { SHOT_MAP, SHOT_RATE, lastMotionTime, sampleTrack } from '../camera/shots.js'
import { resolveDestination } from '../data/destinations.js'
import { GOOGLE_TILES_ASSET, resolveTileAuth } from '../tilesAuth.js'

const D2R = MathUtils.DEG2RAD

/**
 * How far out the fold reaches, in metres past the hinge, and therefore how
 * much city has to exist for it to have anything to lift. Everything else here
 * — the loader camera, the haze, the far plane — is derived from this number.
 *
 * It is also the base of a control now, mirrored by the `foldLength` row in
 * `LOOK_CONTROLS`; keep the two the same. The slider only ever shortens it,
 * because a roll longer than this would reach for city the loader was never
 * asked to stream.
 */
const FOLD_LENGTH = 1900

/** The hinge may approach the viewer, but never pass under the lens. */
const MIN_FOLD_START = 20

/**
 * Below this the roll is tighter than the buildings standing on it: at twenty
 * metres the arc has a radius of six, so an ordinary roofline comes over the
 * top and back down through the pavement it started on.
 */
const MIN_FOLD_LENGTH = 20

/** Margin past the fold, so the leading edge is never the edge of the data. */
const CITY_RADIUS = 2600

/**
 * The loader camera hangs here, looking straight down, with a field of view
 * that just covers `CITY_RADIUS`. See `_initTiles` for why it exists. High
 * enough that the cone is not so wide it meters the edge of the disc at a
 * grazing angle, low enough that the whole disc still fits.
 */
const LOADER_HEIGHT = 2800

/** How far above the pavement the ground probe drops its rays from. */
const PROBE_HEIGHT = 3000

/** How far above whatever it is standing on the camera is held, in metres. */
const CLEARANCE = 4

/**
 * How far the camera may stray from the last ground reading before the next one
 * is asked for. Roughly a city block — closer than that and the answer has not
 * changed, further and it is a reading from somewhere else.
 */
const PROBE_STRIDE = 18

/**
 * Elevation the lens picks up by the time the city is fully over.
 *
 * Deliberately less than it wants to be. Tracking the fold all the way up puts
 * the frame entirely on the ceiling, and a frame with nothing but ceiling in it
 * reads as an aerial photograph — the shot only works while there is still a
 * flat street at the bottom of it to be upside down *relative to*.
 */
const FOLD_TILT = 10 * D2R

/**
 * How long one tile LOD crossfade lasts, in milliseconds. The fade is a
 * screen-space Bayer stipple between two levels of the same city and there is
 * no temporal AA to dissolve it, so it is kept short enough that the pattern
 * never settles long enough to read as texture. Must match the plugin's
 * `fadeDuration` in `_initTiles`.
 */
const TILE_FADE_MS = 420
// A seek that jumps farther than this is a cut (recorder rewinds to the
// opening, the prime at the far end of the move). Live frame hitches must
// NOT use this path — see FADE_MAX_STEP.
const FADE_CUT_STEP = 0.5
// Cap on continuous fade advancement per pump. Tile parse spikes routinely
// produce rAF deltas well past FADE_CUT_STEP; treating those as cuts aborted
// every in-flight crossfade and read as LOD bumps. Clamping keeps the stipple
// alive across the hitch instead.
const FADE_MAX_STEP = 1 / 20

/**
 * The ceiling on the live preview's drawing buffer, as a multiple of the CSS
 * box.
 *
 * Everything expensive in this app is per *pixel*, not per triangle — the cloud
 * march above all, then the tilt-shift's gaussian and the bloom's mip ladder —
 * so this number is the frame budget more directly than any of them.
 * A retina laptop reports 2, which on a full-screen window is nearly seven
 * megapixels of raymarch; 1.5 is a little over half of that for a difference
 * the eye has to look for, because the browser downsamples the buffer into the
 * CSS box and this scene has no thin high-contrast edges to alias — it is
 * photographs, haze and blur passes. Captures are unaffected: `setCaptureSize`
 * takes its own ratio and `Recorder` supersamples on its own terms.
 */
const MAX_PIXEL_RATIO = 1.5

const _down = new Vector3( 0, - 1, 0 )
const _origin = new Vector3()

/**
 * Re-aims an authored crane at new visible endpoints without changing its beat.
 *
 * Sampling is linear in the key values even when time is eased, so one affine
 * map preserves every intermediate pause and acceleration. A flat track has no
 * range to map — `gaze` is one — and becomes the simplest responsive crane.
 */
function retargetHeightTrack( keys, shot, range ) {

	const startTime = shot.duration * ( shot.start || 0 )
	const originalStart = sampleTrack( keys, startTime )
	const originalFinish = sampleTrack( keys, shot.duration )
	const span = originalFinish - originalStart

	if ( Math.abs( span ) < 1e-6 ) return [
		[ startTime, range.start ],
		[ shot.duration, range.finish, 'responsive' ],
	]

	const scale = ( range.finish - range.start ) / span
	return keys.map( ( [ time, value, ...rest ] ) => [
		time,
		range.start + ( value - originalStart ) * scale,
		...rest,
	] )

}

/**
 * Golden hour, as the root of the palette.
 *
 * The sky used to *be* this colour, flat, because the fold puts the rim of the
 * loaded disc anywhere — level with the lens at half a turn, directly overhead
 * at a full one — and any variation in the sky was a variation the rim could be
 * seen against. The constraint is now discharged differently: the haze samples
 * the same `skyColor` function the background draws, along the same ray, so a
 * fully hazed tile matches whatever is behind it by construction and the sky is
 * free to carry a gradient, a sun and clouds. This colour remains the horizon
 * and the base every other sky tone is derived from, which is what keeps the
 * one swatch in the settings moving the whole picture coherently. Barely warm
 * of neutral on purpose: the horizon and the haze fill whole frames during a
 * fold, so any real saturation here reads as weather — a gold root turned the
 * sky into a sandstorm. The summer-evening warmth lives in the sun's glow and
 * the grade instead, and the blue lives in the zenith the gradient climbs to.
 */
const SKY = 0xe6e2d6

export class World {

	constructor( canvas ) {

		this.canvas = canvas
		this.renderer = null
		this.scene = null
		this.camera = null
		this.loaderCamera = null
		this.tiles = null
		this.frame = null
		this.rig = new Rig()
		this.fold = new FoldState()

		this.destination = null
		this.state = 'idle'

		this.groundProbed = false
		this._hasGround = false
		this.groundY = 0
		this.tilesLoading = 0
		this.tilesVisible = 0

		// Screen-space error the tile pipeline aims for, in pixels, and the
		// notional resolution the loader camera is metered at. Between them
		// they set how much city exists and how much it costs; both are worth
		// reaching for from the console.
		this.errorTarget = 12
		this.loaderDetail = 1100

		// Extension points — nothing here calls them by default.
		this.onStateChange = null
		this.onFrame = null
		this.onTileError = null
		this.onShot = null

		this.playing = null
		this._shot = null
		this._shotHeightRanges = new Map()

		this._running = false
		this._lastTime = 0
		this._probeAt = 0
		this._probeTries = 0
		this._materials = new Set()
		this._raycaster = new Raycaster()
		this._followAt = 0
		// Where the pavement and the surface under the camera were last
		// measured. `groundY` eases onto the first; `rig.floorHeight` is derived
		// from the second every frame, because the datum below it is moving.
		this._groundTarget = null
		this._floorTop = null
		this._probedAt = new Vector3()
		// Every render-target-owning node currently in the post chain, so that a
		// rebuild can free the previous one.
		this._passes = []
		// Window size the renderer was last built for, packed into one number.
		this._sized = 0
		this.capturing = false
		this._fadeManager = null
		// Last seek, in real seconds (`authored / SHOT_RATE`). Null until the
		// first seek of a move, so that seek is a cut rather than a fade step
		// across whatever the previous take left behind.
		this._seekRealTime = null

		// Art direction that lives in the post chain rather than in the fold.
		// There is one blur here and it is the tilt-shift: `tilt` is how far the
		// frame outside the sharp band goes towards the gaussian, `tiltBand` is
		// how tall that band is either side of `tiltCenter`, and none of the
		// three is a distance — the wedge is screen space, which is why it is
		// the blur that survives the fold.
		this.look = {
			vignette: uniform( 0.2 ),
			tilt: uniform( 0.15 ),
			tiltBand: uniform( 0.16 ),
			tiltCenter: uniform( 0.52 ),
			aberration: uniform( 0.05 ),
			// The three that grade the frame rather than blur it. `glow` is the
			// bloom's strength — the pass itself is toggled like the other costed
			// ones. `grade` is one dial over the whole film look (S-curve,
			// split-tone, saturation) rather than three underused ones, and
			// `exposure` is a plain gain, because the tiles are photographs and a
			// photograph's brightness is a printing decision, not a lighting one.
			glow: uniform( 0.5 ),
			grade: uniform( 0.5 ),
			exposure: uniform( 1 ),
		}
		// Off. The march is the most expensive thing this app can draw — most of
		// the frame budget on a retina window, for a layer of sky the fold spends
		// most of its run pointing away from — and the picture is the city, not
		// the weather. The pass and its two targets are therefore not in the
		// chain unless the Clouds checkbox puts them there. Everything else the
		// sky commit brought (the gradient, the sun, its glow, the haze sampling
		// the same function) is free and stays.
		this.cloudsEnabled = false
		this.tiltEnabled = true
		this.glowEnabled = true

		this.fold.foldLength = FOLD_LENGTH
		this.hazeScale = 1.1
		this.fold.fogColor.value.setHex( SKY )
		this._applyHaze()

		// The sun and the clouds. Built over the fold state because the two share
		// a palette root (`fogColor`) and a datum (`groundY`), and because the
		// haze in `foldMaterial` has to sample the very same sky the background
		// draws — see `sky.js` for why that identity is the invariant.
		this.sky = new SkyState( this.fold )

	}

	/**
	 * The haze has to be *finished* before the rim is, not around it. A far
	 * plane past `CITY_RADIUS` leaves the last few per cent of tile showing at
	 * the edge of the disc — a hard line across the sky exactly where the eye is
	 * looking for one. `hazeScale` pulls the whole band in or out; the band
	 * reaches the rim at about 1.05, and the default sits above that on
	 * purpose — more city is worth the edge, which the fold covers over as soon
	 * as the horizon starts to lift.
	 */
	_applyHaze() {

		this.fold.fogNear.value = CITY_RADIUS * 0.34 * this.hazeScale
		this.fold.fogFar.value = CITY_RADIUS * 0.95 * this.hazeScale
		return this

	}

	// ---------------------------------------------------------------- setup

	async init( { onProgress, auth = resolveTileAuth() } = {} ) {

		const report = onProgress || ( () => {} )
		this.auth = auth

		report( 'Starting WebGPU' )

		const renderer = this.renderer = new WebGPURenderer( {
			canvas: this.canvas,
			antialias: true,
			powerPreference: 'high-performance',
		} )
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, MAX_PIXEL_RATIO ) )
		// Floored, for the same reason `resize` refuses zero: a page that starts
		// in a hidden or collapsed pane reports 0 here, and a swapchain built at
		// size 0 is invalid for the rest of the session.
		renderer.setSize( Math.max( window.innerWidth, 1 ), Math.max( window.innerHeight, 1 ) )
		// Khronos PBR Neutral, applied by the pipeline after the whole post
		// chain, and the one display transform this scene can take. Almost
		// everything on screen is a *photograph*: Google's mesh arrives already
		// printed, with a camera's own S-curve baked into it. A scene-referred
		// film transform run over that develops the negative twice — AgX, the
		// sibling project's, hangs its shoulder over Paris limestone and returns
		// chalk: measured over the Rue César Franck frame it piled two thirds of
		// the picture into a single band around 0.6, with a mean saturation of
		// 0.10 and 0.2% of pixels below quarter-black. That reads as burnt, and
		// no amount of exposure fixes it, because the density is gone rather than
		// misplaced. Neutral is the identity below 0.8 and only compresses above
		// it, so the tiles come out as photographed (same frame: saturation 0.27,
		// 12% real shadow) while the things this scene authors *past* white in
		// the half-float chain — the sun's disc, the heart of its glow, the lit
		// cloud rims, the bloom the pass adds back — still roll off instead of
		// clipping. Exposure is 1: a photograph printed at its own brightness.
		// The grade and the exposure slider are the hand-tuning on top.
		renderer.toneMapping = NeutralToneMapping
		renderer.toneMappingExposure = 1
		renderer.outputColorSpace = SRGBColorSpace

		await renderer.init()

		this.scene = new Scene()
		// The same function the haze mixes toward, not a copy of it: matched by
		// construction, so a change of colour can never leave a seam behind.
		// Only the background gets the sun's disc — see `skyColor`. The clouds
		// are not here: they are a raymarched post pass (`clouds.js`), folded
		// with the city, composited over scene and sky alike by transmittance.
		this.scene.backgroundNode = skyColor( positionWorldDirection, this.sky, { disc: true } )

		// Near is generous for a camera that lives at head height. Far only has
		// to reach past the haze: everything beyond `fogFar` is a
		// flat wash of sky colour whether it is drawn or not, and after the fold
		// it is a flat wash of sky colour *overhead*, which is the one place a
		// few thousand extra triangles buy nothing at all.
		this.camera = new PerspectiveCamera( this.rig.fov, this._aspect(), 2, CITY_RADIUS * 4 )

		// Straight down over the site. `updateMatrixWorld` rather than lookAt:
		// looking along −y is exactly where lookAt is degenerate.
		this.loaderCamera = new PerspectiveCamera(
			2 * Math.atan( CITY_RADIUS / LOADER_HEIGHT ) / D2R, 1, 100, LOADER_HEIGHT * 3,
		)
		this.loaderCamera.position.set( 0, LOADER_HEIGHT, 0 )
		this.loaderCamera.rotation.set( - Math.PI / 2, 0, 0 )
		this.loaderCamera.updateMatrixWorld()

		this._initPost()

		report( 'Connecting to the tiles' )
		this._initTiles( auth )

		this.rig.attach( this.canvas )
		// Touching the camera takes the shot off the rails. A move you cannot
		// interrupt is a video, and the interesting frame is never the one the
		// author stopped on.
		//
		// Not during a capture. The recorder drives the same shot, and dropping
		// `_shot` mid-file makes every later `seek` a no-op — so the encoder goes
		// on writing frames, the file saves, and the back half of it is one
		// frozen image. A drag that ruins the take without saying so is worse
		// than a drag that does nothing.
		this.rig.onChange = () => { if ( ! this.capturing ) this.stopShot() }
		this.resize()

		return this

	}

	/**
	 * The post chain, rebuilt whenever a pass is turned on or off.
	 *
	 * Rebuilding rather than dialling a strength to zero is the point: the
	 * cloud pass is a raymarch and two targets, the tilt-shift is a gaussian and
	 * the bloom is a mip ladder — none of which gets cheaper for being
	 * invisible. The vignette is always in the chain, because it is two
	 * instructions.
	 */
	_initPost() {

		const post = this.post || ( this.post = new RenderPipeline( this.renderer ) )

		// Every node in this chain that is not the vignette owns a render target
		// — the pass, the cloud RTT, the gaussian's two, the bloom's ladder —
		// and none of them are reachable from the graph once it has been replaced.
		// Rebuilding without this is a full-screen framebuffer leaked per toggle
		// of a checkbox. `RTTNode` frees nothing on its own, so its target is
		// released by hand alongside.
		for ( const node of this._passes ) {

			node.dispose()
			if ( node.isRTTNode ) node.renderTarget.dispose()

		}
		this._passes.length = 0

		const scenePass = pass( this.scene, this.camera )
		this._passes.push( scenePass )
		const { vignette, tilt, tiltBand, tiltCenter, aberration } = this.look

		// What everything downstream reads: the scene, or the scene with the
		// clouds marched over it.
		//
		// The clouds march over the finished scene, reading its depth — that is
		// what lets a tower stand in front of one cloud and behind another, and
		// what dims the sun's disc through the deck. Two targets, not one: the
		// march runs in its own reduced-resolution target (`clouds.js` says why
		// — it is the most expensive thing in the frame by a wide margin), and
		// the composite of that layer over the scene goes into one explicit
		// full-resolution RTT so the bloom and the tilt-shift read the *clouded*
		// frame from a single texture. Bloom taken before the clouds would halo the
		// sun through an overcast, and each node wrapping the composite itself
		// would buy a second full-screen target.
		//
		// Rebuilt out of the chain when off, like the other costed passes. The
		// coverage slider is *not* that switch and must not become it: it is a
		// shot channel, a rebuild per frame of a drag would recompile the
		// pipeline several times a second, and the uniform branch inside the
		// march already makes a coverage of zero skip the marching. What it
		// cannot skip is the pair of full-screen targets the pass owns, which is
		// what this removes.
		let source = scenePass.getTextureNode()

		if ( this.cloudsEnabled ) {

			const clouds = volumetricClouds( {
				color: source,
				depth: scenePass.getTextureNode( 'depth' ),
			}, this.fold, this.sky, this.camera )
			this._passes.push( clouds.layer )
			source = convertToTexture( clouds.composite )
			this._passes.push( source )

		}

		let image = source

		if ( this.tiltEnabled ) {

			// Tilt-shift: the only blur in the chain. It ignores depth entirely
			// and softens by *height in frame* — the miniature-faking trick used
			// backwards — which costs one half-resolution gaussian and buys the
			// top and bottom of the frame back as atmosphere. Depth of field
			// used to sit in front of it and no longer does: once the whole
			// frame has arrived at the same distance a focal plane has nothing
			// left to say, and four full-frame passes were being spent on a
			// picture the fold had already flattened. A screen-space wedge is
			// what reads at full fold.
			//
			// `image` is a texture node here — the scene pass or the cloud RTT —
			// which is what `gaussianBlur` wants: it runs its input through
			// `convertToTexture`, which passes a texture or a pass node straight
			// through and wraps anything else in a full-resolution half-float
			// target plus a fullscreen copy per frame.
			const soft = gaussianBlur( image, vec2( 1 ), 9, { resolutionScale: 0.5 } )
			this._passes.push( soft )
			const band = abs( screenUV.y.sub( tiltCenter ) )
			const amount = smoothstep( tiltBand, tiltBand.add( 0.3 ), band ).mul( tilt )
			image = vec4( mix( image.rgb, soft.rgb, amount ), image.a )

		}

		if ( this.glowEnabled ) {

			// Thresholded at 1.0, which is the whole trick: the tiles are
			// photographs and never reach white, while the sun's disc, the heart
			// of its glow and the brightest cloud linings are authored *past* it
			// — so the sun blooms through the closing fold and the city stays
			// crisp. The input is the *clouded* frame, not the raw scene pass: a
			// sun the deck has covered must not keep haloing through it. Feeding
			// it the unblurred texture changes nothing visible in a glow layer
			// and reuses the RTT that already exists.
			const glowLayer = bloom( source, this.look.glow, 0.4, 1 )
			this._passes.push( glowLayer )
			image = vec4( image.rgb.add( glowLayer.rgb ), image.a )

		}

		// Chromatic aberration last of the image effects, so it fringes the
		// blurs rather than being blurred away by them. It stays in the chain at
		// zero strength: unlike the cloud march and the gaussian it is a handful of
		// extra taps on one pass, so rebuilding the graph to switch it off would
		// cost more in shader compiles than it ever saves in fragments.
		// The centre is passed explicitly. The signature defaults it to `null`
		// and the docs say null means screen centre, but `nodeObject( null )` is
		// null and the node calls `.build()` on it — a TSL TypeError at compile
		// time, which surfaces as a scene that renders nothing at all.
		image = chromaticAberration( image, aberration, vec2( 0.5, 0.5 ), 1.4 )

		// The grade, after the fringing and before the vignette — the order a
		// film gets finished in. One dial: an S-curve for contrast, a nudge of
		// saturation, and a split-tone that cools the shadows and warms the
		// lights — biased toward gold, because the light this scene keys on is a
		// low sun and the tiles are unlit: the split-tone is the only channel
		// that can lay evening colour on a sunward facade the haze has not
		// reached. The curve runs on values clamped to [0,1] but is *mixed* with
		// the unclamped frame, so the over-white sun keeps the energy the bloom
		// threshold reads. Exposure is a plain gain ahead of it all: the tiles
		// carry their own photographed light, and this is the print coming up or
		// down, not a second sun.
		const { grade, exposure } = this.look
		const exposed = image.rgb.mul( exposure )
		const clamped = exposed.clamp( 0, 1 )
		const curved = clamped.mul( clamped ).mul( float( 3 ).sub( clamped.mul( 2 ) ) )
		const contrasted = mix( exposed, curved, grade.mul( 0.65 ) )
		const luma = dot( contrasted, vec3( 0.2126, 0.7152, 0.0722 ) )
		const satted = mix( vec3( luma ), contrasted, grade.mul( 0.22 ).add( 1 ) )
		const graded = satted.add( luma.sub( 0.5 ).mul( grade ).mul( vec3( 0.1, 0.025, - 0.07 ) ) )
		image = vec4( graded, image.a )

		// Corrected for aspect, so the falloff is a circle rather than an
		// ellipse that darkens the sides and not the corners. Both axes are
		// scaled *up* rather than one being scaled by the ratio: multiplying
		// only x by width/height shrinks the whole field on a portrait window,
		// which does not make the vignette circular, it switches it off.
		const aspect = screenSize.x.div( screenSize.y )
		const offset = screenUV.sub( 0.5 ).mul( vec2( max( aspect, 1 ), max( aspect.reciprocal(), 1 ) ) )
		const falloff = smoothstep( 0.42, 1.05, length( offset ) ).mul( vignette )

		post.outputNode = vec4( image.rgb.mul( float( 1 ).sub( falloff ) ), image.a )
		post.needsUpdate = true
		return this

	}

	setTilt( enabled ) {

		if ( this.tiltEnabled === Boolean( enabled ) ) return this
		this.tiltEnabled = Boolean( enabled )
		return this._initPost()

	}

	setGlow( enabled ) {

		if ( this.glowEnabled === Boolean( enabled ) ) return this
		this.glowEnabled = Boolean( enabled )
		return this._initPost()

	}

	/**
	 * The cloud pass in or out of the chain. Not the same control as
	 * `setClouds`, which is the coverage the march draws — this is whether the
	 * march and its two targets exist at all.
	 */
	setCloudPass( enabled ) {

		if ( this.cloudsEnabled === Boolean( enabled ) ) return this
		this.cloudsEnabled = Boolean( enabled )
		return this._initPost()

	}

	_initTiles( auth ) {

		const dracoLoader = new DRACOLoader()
		dracoLoader.setDecoderPath( DRACO_GLTF_CONFIG )

		const tiles = this.tiles = new TilesRenderer()

		// The renderer comes up before a credential does, so the sky is what the
		// setup card sits on. With no auth plugin the tileset has no URL and the
		// pipeline simply has nothing to fetch; `reauthorize` rebuilds this.
		this.tilesAuthorized = Boolean( auth.key )
		if ( this.tilesAuthorized ) {

			tiles.registerPlugin( auth.kind === 'google'
				? new GoogleCloudAuthPlugin( { apiToken: auth.key, autoRefreshToken: true } )
				: new CesiumIonAuthPlugin( {
					apiToken: auth.key,
					assetId: GOOGLE_TILES_ASSET,
					autoRefreshToken: true,
				} ) )

		}
		tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader } ) )

		// The LOD crossfade, minus its GLSL. The stock plugin patches materials
		// through `onBeforeCompile`, which a node material never calls — under
		// WebGPU it fails silently — but its *scheduling* half is renderer-
		// agnostic, so only the material manager is swapped for the node one
		// that drives `foldMaterial`'s own fade uniforms. The fade-out cap is
		// lifted for the sibling project's reason: an arrival streams hundreds
		// of refining tiles at once, and the cap pops exactly the tiles the
		// fade exists for.
		const fade = this.tilesFade = new TilesFadePlugin( {
			fadeDuration: TILE_FADE_MS,
			maximumFadeOutTiles: Infinity,
		} )
		fade._fadeMaterialManager = new NodeFadeManager()
		tiles.registerPlugin( fade )

		// See `_updateTiles`: the fade runs on the shot's clock, not the wall's.
		this._fadeManager = fade._fadeManager ?? null
		if ( ! this._fadeManager ) {

			console.warn( 'TilesFadePlugin: no _fadeManager — tile fades will run on the wall clock, and will not survive a recording.' )

		}

		// Two cameras, and the second one is the reason the fold works at all.
		//
		// Screen-space error is measured against the *unfolded* city, because
		// the bend only exists in the vertex shader. So the pipeline's idea of
		// what is worth loading is whatever the lens can see from head height —
		// and at full fold, most of the frame is city that was a kilometre
		// behind the camera before it came over the top. Left to the main
		// camera alone, the ceiling arrives as root-level mush, or missing.
		//
		// The loader camera hangs over the site looking down, framing exactly
		// the disc the fold can reach. It never renders. It exists to hold a
		// floor under the level of detail across the whole neighbourhood, in
		// every direction, before the viewer has any reason to look there.
		tiles.setCamera( this.camera )
		tiles.setCamera( this.loaderCamera )
		tiles.setResolution( this.loaderCamera, this.loaderDetail, this.loaderDetail )
		tiles.setResolutionFromRenderer( this.camera, this.renderer )

		// `displayActiveTiles` is the obvious way to do the same job and the
		// wrong one. It keeps every *active* tile in the scene, and on a tileset
		// that covers the planet the tiles nobody is looking at never refine —
		// so the scene fills with root-level continents, and standing in Paris
		// means standing inside a brown mesh the size of France.
		//
		// The loader camera does not have that failure mode: it puts the
		// neighbourhood inside a frustum, which both refines it *and* displays
		// it, and leaves the rest of the Earth alone.
		tiles.displayActiveTiles = false

		// Every per-object frustum test in three is wrong about this geometry —
		// a bent vertex leaves its bounding sphere kilometres behind. This flag
		// is on by default; it is named here because turning it off would empty
		// the sky at exactly the moment the effect starts.
		tiles.autoDisableRendererCulling = true

		tiles.errorTarget = this.errorTarget
		tiles.lruCache.minBytesSize = 0.6 * 2 ** 30
		tiles.lruCache.maxBytesSize = 0.9 * 2 ** 30
		tiles.downloadQueue.maxJobs = 24
		tiles.parseQueue.maxJobs = 6

		// The Google auth plugin forces errorTarget to 20 once the Ion endpoint
		// resolves, so ours has to be reapplied after the root tileset lands.
		tiles.addEventListener( 'load-root-tileset', () => {

			tiles.errorTarget = this.errorTarget

		} )

		tiles.addEventListener( 'load-model', event => this._foldModel( event.scene ) )

		// The tile renderer disposes the materials it recorded when the model was
		// parsed, which are the ones `_foldModel` replaced — it never learns
		// about the folding materials, so they are ours to free. The textures
		// are not: those are still the renderer's, and are on both materials.
		tiles.addEventListener( 'dispose-model', event => {

			event.scene.traverse( object => {

				if ( this._materials.delete( object.material ) ) object.material.dispose()

			} )

		} )

		tiles.addEventListener( 'load-error', event => {

			if ( this.onTileError ) this.onTileError( event )

		} )

		this.scene.add( tiles.group )

		if ( this.frame ) this._installFrame()

	}

	/** Rebuilds the tile renderer against a different key, keeping the scene. */
	async reauthorize( auth ) {

		this.auth = auth
		this.scene.remove( this.tiles.group )
		this.tiles.dispose()
		for ( const material of this._materials ) material.dispose()
		this._materials.clear()
		this._initTiles( auth )

	}

	// ----------------------------------------------------------- destination

	/**
	 * Moves the whole world to a new city.
	 *
	 * The tile set is not rebuilt — it is the same planet — but the frame
	 * underneath it is, which slides the streaming window across the globe and
	 * puts the new pavement back at the origin.
	 *
	 * `arrive` is the crane from above. A reload that already knows the pose
	 * skips it — putting the camera two-and-a-half rooftops up and damping
	 * down would fight the restored height on the first frames.
	 */
	setDestination( source, { arrive = true } = {} ) {

		const destination = this.destination = resolveDestination( source )

		this.stopShot()
		this.frame = new Frame( this.tiles.ellipsoid, destination.latRad, destination.lonRad )
		this._installFrame()

		// The authored height is a placeholder good to a few metres; `_probe`
		// replaces it with the mesh's own answer as soon as there is mesh.
		this.groundProbed = false
		this._hasGround = false
		this._probeTries = 0
		this._probeAt = 0
		this.rig.floorHeight = 0
		this.rig.x = 0
		this.rig.z = 0
		this._groundTarget = null
		this._floorTop = null
		this._setGroundY( destination.groundHeight )
		this._followCenter()

		this.setFoldStart( destination.foldStart )
		this.fold.setBearing( destination.bearingRad )
		this.sky.aim( destination.bearingRad )
		this.setBend( 0 )

		this.rig.setBearing( destination.bearingRad )
		this.setStance( 'rooftop' )
		if ( arrive ) {

			// Arrive rather than cut. The rig's own damping is the whole move:
			// start high and pitched down, where the coarse tiles that land
			// first are least wrong, and let it settle onto the roofline over
			// about a second as the detail catches up.
			this.rig.setHeight( destination.rooftop * 2.4, { immediate: true } )
			this.rig.setHeight( destination.rooftop )
			this.rig.setPitch( - 20 * D2R, { immediate: true } )
			this.rig.setPitch( - 3 * D2R )

		} else {

			this.rig.setHeight( destination.rooftop, { immediate: true } )
			this.rig.setPitch( - 3 * D2R, { immediate: true } )

		}

		this.rig.apply( this.camera )

		this._setState( 'loading' )
		return destination

	}

	/**
	 * Where the camera is standing, looking, and how far the city has come
	 * over — the pose a reload has to put back, not the destination it is in.
	 *
	 * Yaw and fold bearing are stored apart: looking around turns the head
	 * without moving the hinge, and only Start (or a walk that pans the
	 * effect) keeps them the same number.
	 */
	readView() {

		const axis = this.fold.axis.value
		return {
			x: this.rig.x,
			z: this.rig.z,
			// Targets, not the in-flight damped pose: a reload restores
			// immediately, so the number the sliders asked for is the one
			// that has to come back, not wherever the crane had got to.
			yaw: this.rig._targetYaw,
			pitch: this.rig._targetPitch,
			height: this.rig._targetHeight,
			bend: this.fold.bend,
			foldBearing: Math.atan2( axis.x, - axis.y ),
			stance: this.stance,
		}

	}

	/**
	 * Puts a `readView` back, immediately. Missing fields are left alone so a
	 * partial session can still restore the pieces it has.
	 */
	restoreView( view ) {

		if ( ! view ) return this

		if ( Number.isFinite( view.foldBearing ) ) {

			this.fold.setBearing( view.foldBearing )
			this.sky.aim( view.foldBearing )

		}

		if ( Number.isFinite( view.yaw ) ) this.rig.setBearing( view.yaw )
		if ( Number.isFinite( view.pitch ) ) this.rig.setPitch( view.pitch, { immediate: true } )
		if ( Number.isFinite( view.height ) ) this.rig.setHeight( view.height, { immediate: true } )
		if ( Number.isFinite( view.x ) && Number.isFinite( view.z ) ) this.rig.setGround( view.x, view.z )
		if ( Number.isFinite( view.bend ) ) this.setBend( view.bend )
		if ( view.stance ) this.stance = view.stance
		this._followCenter()
		this.rig.apply( this.camera )
		return this

	}

	/**
	 * The three places worth standing. `street` is the one the effect is named
	 * for and the one Google's mesh is least kind to — photogrammetry has no
	 * interiors, so a pavement coordinate that is a metre out puts the lens
	 * inside a wall. It is offered, not defaulted to.
	 */
	setStance( stance ) {

		const destination = this.destination
		if ( ! destination ) return this

		const height = stance === 'street' ? destination.street
			: stance === 'high' ? Math.max( destination.rooftop * 3, 420 )
				: destination.rooftop

		this.stance = stance
		this.rig.setHeight( height )
		return this

	}

	_installFrame() {

		const group = this.tiles.group
		this.frame.toLocal.decompose( group.position, group.quaternion, group.scale )
		group.updateMatrixWorld( true )

	}

	_setGroundY( y ) {

		this.groundY = y
		this.fold.groundY.value = y
		this.rig.groundY = y
		this.loaderCamera.position.y = y + LOADER_HEIGHT
		this.loaderCamera.updateMatrixWorld()

	}

	/**
	 * Puts the fold — and the disc of city it needs — under the camera.
	 *
	 * Walking pans the whole effect rather than sliding out from under it: the
	 * hinge stays the same distance in front of the viewer, the haze stays the
	 * same distance all round, and the loader camera drags the streaming window
	 * along so there is always city to fold. The frame origin does not move,
	 * because that is the float32 anchor and moving it would mean rebuilding
	 * every tile transform; only the deformation re-centres.
	 */
	_followCenter() {

		const { x, z } = this.rig
		const center = this.fold.center.value
		if ( center.x === x && center.y === z ) return this

		center.set( x, z )
		this.loaderCamera.position.x = x
		this.loaderCamera.position.z = z
		this.loaderCamera.updateMatrixWorld()
		return this

	}

	/**
	 * Reads the pavement off the mesh around a point on the ground plane.
	 *
	 * Answers two questions with one set of rays, and they are different
	 * questions. `ground` is the local street — the datum the bend measures
	 * height from — and `top` is the surface directly under that point, which is
	 * the street if it is in a road and a roof if it is not.
	 *
	 * Authored elevations are orthometric plus a geoid estimate, which is good
	 * to a few metres — enough to bury a street-level camera in a kerb. Once
	 * there is mesh under the point, its geometry is the authority.
	 *
	 * A spread of rays, and a low quantile rather than a first hit or a median.
	 * A single ray answers the moment the coarse root shell passes overhead,
	 * tens of metres out, and the camera spends the rest of the session
	 * underground. A median is worse in exactly the places this app is for:
	 * over Midtown, more than half of any ring of downward rays lands on a
	 * roof, so the median *is* a roof — it read 30 m high there, which is a
	 * ten-storey building, and every height in the interface inherited it.
	 *
	 * The low quantile is the cheapest thing that finds the street: the bottom
	 * of a spread of rays over a city block is a road or a courtyard, and going
	 * one step in from the true minimum spends the outlier that fell through a
	 * hole in the mesh into an underpass.
	 */
	probeGround( { x = 0, z = 0, radii = [ 40, 95, 170 ], perRing = 6, minHits = 6 } = {} ) {

		if ( ! this.frame ) return null

		const raycaster = this._raycaster
		raycaster.firstHitOnly = true
		raycaster.near = 0
		raycaster.far = PROBE_HEIGHT * 2
		const from = this.groundY + PROBE_HEIGHT

		const hits = []
		const cast = ( px, pz ) => {

			raycaster.set( _origin.set( px, from, pz ), _down )
			const hit = raycaster.intersectObject( this.tiles.group, true )[ 0 ]
			if ( hit ) hits.push( hit.point.y )
			return hit ? hit.point.y : null

		}

		// Manhattan is where the centre ray stops being pedantic: an address on
		// 7th Avenue that is three metres off is inside a tower, and "over the
		// roofs" put the lens in a lift shaft. The rig takes `top` as a floor, so
		// a camera on a building starts above it, while a camera in a street
		// canyon — where the centre ray *is* the road — is unaffected.
		const top = cast( x, z )
		for ( let r = 0; r < radii.length; r ++ ) {

			// Each ring is rotated off the last so the samples do not line up
			// along the same three bearings and all land on the same street.
			const phase = r * Math.PI / ( perRing * radii.length )
			for ( let i = 0; i < perRing; i ++ ) {

				const angle = phase + i / perRing * Math.PI * 2
				cast( x + Math.sin( angle ) * radii[ r ], z + Math.cos( angle ) * radii[ r ] )

			}

		}

		if ( hits.length < minHits ) return null

		hits.sort( ( a, b ) => a - b )
		const ground = hits[ Math.min( 1, hits.length - 1 ) ]
		if ( ! isFinite( ground ) ) return null

		return { ground, top }

	}

	/** The top of whatever stands at a point on the ground plane, or null. */
	surfaceAt( x, z ) {

		const raycaster = this._raycaster
		raycaster.firstHitOnly = true
		raycaster.near = 0
		raycaster.far = PROBE_HEIGHT * 2
		raycaster.set( _origin.set( x, this.groundY + PROBE_HEIGHT, z ), _down )
		const hit = raycaster.intersectObject( this.tiles.group, true )[ 0 ]
		return hit ? hit.point.y : null

	}

	/**
	 * Re-datums the fold under the camera as it walks.
	 *
	 * `groundY` is the height the bend measures every vertex from, so it has to
	 * stay under `fold.center` — and the centre now walks. Leaving it on the
	 * arrival coordinate meant that after a climb the local street counted as
	 * *height above the pavement*: walk up to the Peak in Hong Kong and 500 m of
	 * hillside is treated as 500 m of building, which does not lean out of the
	 * arc, it rescales the whole roll. At the default settings the far side of
	 * the city stops coming over and curls back down under the viewer instead.
	 *
	 * Damped rather than snapped. The probe runs a few times a second, and a
	 * datum that stepped would step the whole folded city with it.
	 */
	followGround() {

		// Two rings rather than three: this runs while walking, and the third
		// ring is there to survive a coordinate dropped in a courtyard, which
		// is an arrival problem.
		const probe = this.probeGround( {
			x: this.rig.x, z: this.rig.z, radii: [ 45, 100 ], perRing: 6, minHits: 4,
		} )
		// A probe over ground that has not streamed in yet answers null, and the
		// old value is then a reading from wherever the camera used to be —
		// which after a sprint is kilometres away. Record where the answer came
		// from either way, so the next attempt is not deferred by the throttle.
		this._probedAt.set( this.rig.x, 0, this.rig.z )
		if ( ! probe ) return this

		this._groundTarget = probe.ground
		if ( probe.top !== null ) this._floorTop = probe.top
		return this

	}

	/** Eases `groundY` and the clearance onto whatever `followGround` measured. */
	_settleGround( dt ) {

		if ( this._groundTarget === null ) return this

		const gap = this._groundTarget - this.groundY
		if ( Math.abs( gap ) > 1e-3 ) this._setGroundY( this.groundY + gap * ( 1 - Math.exp( - dt * 2.5 ) ) )

		// Eased, and asymmetrically. Assigning the clearance straight from the
		// probe teleports the camera the height of a building every time a
		// reading crosses a roof edge, four times a second at walking speed.
		// Rising is quick because the alternative is the lens passing through a
		// wall; falling is slow because a roof edge is a cliff, and dropping off
		// one at the same rate reads as the camera being dropped.
		if ( this._floorTop !== null ) {

			const target = this._floorTop - this.groundY + CLEARANCE
			const rate = target > this.rig.floorHeight ? 14 : 3
			this.rig.floorHeight += ( target - this.rig.floorHeight ) * ( 1 - Math.exp( - dt * rate ) )

		}

		return this

	}

	/**
	 * Walks the camera off a roof, while preserving verified street framing.
	 *
	 * Downward hits can tell a roof from a low surface, but cannot tell asphalt
	 * from a courtyard, park, water or the deck below an overpass. The broad
	 * perspective therefore comes from a visually checked `streetCenter`
	 * destination. For arbitrary coordinates, a bounded spiral still finds the
	 * nearest safe low surface without pretending it knows what that surface is.
	 */
	findOpenGround( { reach = 140, rings = 4, perRing = 10, tolerance = 6 } = {} ) {

		const street = this.groundY
		const originX = this.rig.x
		const originZ = this.rig.z
		const here = this.surfaceAt( originX, originZ )
		if ( here !== null && here - street <= tolerance ) {

			if ( ! this.destination?.streetCenter ) return null
			const center = {
				x: originX, z: originZ, top: here, ground: street,
				radius: 0, corridor: true,
			}
			this._placeOnGround( center )
			return center

		}

		let best = null
		for ( let ring = 1; ring <= rings; ring ++ ) {

			const radius = reach * ring / rings
			for ( let index = 0; index < perRing; index ++ ) {

				// Offset each ring so the samples spiral rather than stack up
				// along the same few bearings.
				const angle = ( index + ring * 0.37 ) / perRing * Math.PI * 2
				const x = originX + Math.sin( angle ) * radius
				const z = originZ + Math.cos( angle ) * radius
				const top = this.surfaceAt( x, z )
				if ( top === null || top - street > tolerance ) continue
				if ( ! best || radius < best.radius ) best = { x, z, top, radius }

			}

			if ( best ) break

		}

		if ( ! best ) return null
		best.ground = street
		best.corridor = false
		this._placeOnGround( best )
		return best

	}

	/** Applies a validated arrival position without changing the ground datum. */
	_placeOnGround( ground ) {

		this.rig.setGround( ground.x, ground.z )
		this._floorTop = ground.top
		this._groundTarget = ground.ground
		this.rig.floorHeight = ground.top - this.groundY + CLEARANCE
		this._followCenter()
		return this

	}

	// ------------------------------------------------------- art direction

	/** Where the flat ground ends, in metres along the fold axis. */
	setFoldStart( metres ) {

		this.fold.hinge.value = Math.max( MIN_FOLD_START, metres )
		return this

	}

	/**
	 * How much ground the half turn is spent over, in metres past the hinge.
	 *
	 * Clamped to `FOLD_LENGTH` at the top: the loaded disc is sized for that
	 * reach, and a longer roll would bend the rim of the data into frame.
	 */
	setFoldLength( metres ) {

		this.fold.setFoldLength( MathUtils.clamp( metres, MIN_FOLD_LENGTH, FOLD_LENGTH ) )
		return this

	}

	/** How far round the roll goes before the rest runs on straight, in radians. */
	setCurl( radians ) {

		this.fold.curl.value = radians
		return this

	}

	setHaze( scale ) {

		this.hazeScale = scale
		return this._applyHaze()

	}

	setSkyColor( hex ) {

		this.fold.fogColor.value.setHex( hex )
		return this

	}

	/** Degrees off the fold axis the sun stands, positive clockwise. */
	setSunBearing( degrees ) {

		this.sky.setOffset( degrees * D2R )
		return this

	}

	setSunHeight( degrees ) {

		this.sky.setElevation( degrees * D2R )
		return this

	}

	setClouds( coverage ) {

		this.sky.coverage.value = MathUtils.clamp( coverage, 0, 1 )
		return this

	}

	setFov( degrees ) {

		this.rig.fov = degrees
		return this

	}

	/** Every art-direction value at once, in the units the interface uses. */
	readLook() {

		return {
			foldStart: this.fold.hinge.value,
			foldLength: this.fold.foldLength,
			curl: this.fold.curl.value / D2R,
			fov: this.rig.fov,
			haze: this.hazeScale,
			sunAzim: this.sky.offset / D2R,
			sunHeight: this.sky.elevation / D2R,
			clouds: this.sky.coverage.value,
			tilt: this.look.tilt.value,
			tiltBand: this.look.tiltBand.value,
			tiltAt: this.look.tiltCenter.value,
			vignette: this.look.vignette.value,
			aberration: this.look.aberration.value,
			glow: this.look.glow.value,
			grade: this.look.grade.value,
			exposure: this.look.exposure.value,
			drift: this.rig.sway,
		}

	}

	// ------------------------------------------------------------------ shots

	/** Sets the visible camera-height endpoints for the next run of one move. */
	setShotHeightRange( id, start, finish ) {

		const shot = SHOT_MAP.get( id )
		if ( ! shot?.tracks.height
			|| ! Number.isFinite( start )
			|| ! Number.isFinite( finish ) ) return this

		this._shotHeightRanges.set( id, {
			start: MathUtils.clamp( start, MIN_HEIGHT, MAX_HEIGHT ),
			finish: MathUtils.clamp( finish, MIN_HEIGHT, MAX_HEIGHT ),
		} )
		return this

	}

	/**
	 * Plays an authored move.
	 *
	 * The shot drives the same setters the sliders do, so the panel can follow
	 * along and the viewer can take the controls back mid-move simply by
	 * touching one — `stopShot` is on `rig.onChange` and on every control in
	 * `main.js` that writes a channel a shot also writes. It leaves
	 * everything exactly where the move left it rather than restoring what was
	 * there before: a shot that tidied up after itself would make the interesting
	 * frame the one you cannot keep.
	 */
	playShot( id ) {

		const shot = SHOT_MAP.get( id )
		// The move opens four metres above a real pavement. Before the last
		// ground probe, that pavement is still a coarse planetary shell and the
		// same number can put the lens inside a roof when detail arrives.
		if ( ! shot || ! this.groundProbed ) return this

		const openingYaw = this.rig.yaw
		if ( shot.shape ) this.setShape( shot.shape )
		// Start takes the view as the shot's forward direction. Keeping the
		// destination's arrival bearing here puts the hinge beside or behind a
		// viewer who looked around before pressing it.
		this.setBearing( openingYaw )
		const tracks = { ...shot.tracks }
		const heightRange = this._shotHeightRanges.get( shot.id )
		if ( tracks.height && heightRange ) {

			tracks.height = retargetHeightTrack( tracks.height, shot, heightRange )

		}
		if ( tracks.foldStart ) {

			// The first key becomes the live hinge, and every later key is
			// capped at whichever is farther out: that live hinge, or the
			// move's own landing value. The cap exists because the authored
			// tracks hold approach waypoints a couple of hundred metres out
			// for the dive from the base look's sixteen hundred, and a replay
			// opens with the hinge already nearer than that — without it the
			// opening slides the hinge back out to the waypoint, the fold
			// retreating before it advances. But the cap must not be the live
			// hinge alone: every move leaves the hinge low when it ends, and
			// capping the next move's whole track there plays `dream` after
			// `fold` at twenty metres — a crease on top of the viewer with the
			// rooflines through the lens. Letting the landing value through
			// keeps every authored end state reachable, and any travel back
			// out to it rides the track's own ease instead of snapping.
			const live = this.fold.hinge.value
			const settle = tracks.foldStart[ tracks.foldStart.length - 1 ][ 1 ]
			const cap = Math.max( live, settle )
			tracks.foldStart = tracks.foldStart.map( ( key, index ) =>
				index === 0
					? [ key[ 0 ], live ]
					: [ key[ 0 ], Math.min( key[ 1 ], cap ), ...key.slice( 2 ) ] )

		}

		// Position and bearing are relative to where the shot opened, so the
		// same move works from anywhere the viewer happens to have walked to.
		this._shot = {
			shot,
			tracks,
			time: shot.duration * ( shot.start || 0 ),
			// Past the last arriving key the pose is a hold. Live and capture
			// both stop here rather than encoding the rest as still video.
			end: lastMotionTime( tracks, shot.duration ),
			x: this.rig.x,
			z: this.rig.z,
			yaw: openingYaw,
		}

		this.playing = shot.id
		this._seekRealTime = null
		if ( this.onShot ) this.onShot( shot )
		return this

	}

	stopShot() {

		if ( ! this._shot ) return this
		this._shot = null
		this.playing = null
		// Bend, height and lens hold the interrupted frame. Shake is motion rather
		// than a frame, so Stop and the natural ending settle it completely.
		this.rig.sway = 0
		if ( this.onShot ) this.onShot( null )
		return this

	}

	_advanceShot( dt ) {

		const state = this._shot
		if ( ! state ) return this

		// Authored seconds, not wall-clock ones: the tracks are sampled in the
		// time they were written in and `SHOT_RATE` decides how fast the clock
		// runs through them.
		state.time += dt * SHOT_RATE
		const until = state.end ?? state.shot.duration
		if ( state.time >= until ) {

			this._applyShotAt( until )
			return this.stopShot()

		}

		return this._applyShotAt( state.time )

	}

	/**
	 * Puts the running move at an absolute time, rather than a step past where
	 * it was.
	 *
	 * `_advanceShot` is what the live loop wants and `seek` is what a recorder
	 * wants, and they have to be the same function or the file and the screen
	 * are two different moves. Every channel is a pure function of `t` — nothing
	 * here integrates — which is what makes seeking legal at all.
	 */
	_applyShotAt( time ) {

		const state = this._shot
		if ( ! state ) return this

		state.time = time
		const { tracks } = state

		for ( const key in tracks ) {

			const value = sampleTrack( tracks[ key ], time )
			if ( value === null || key === 'dolly' || key === 'strafe' ) continue
			this._applyChannel( key, value, state )

		}

		if ( tracks.dolly || tracks.strafe ) {

			const dolly = tracks.dolly ? sampleTrack( tracks.dolly, time ) : 0
			const strafe = tracks.strafe ? sampleTrack( tracks.strafe, time ) : 0
			// Along the bearing the shot *opened* on, not the current one, so a
			// yaw drift turns the head without curving the track.
			const sin = Math.sin( state.yaw )
			const cos = Math.cos( state.yaw )
			this.rig.setGround( state.x + sin * dolly + cos * strafe, state.z - cos * dolly + sin * strafe )

		}

		return this

	}

	_applyChannel( key, value, state ) {

		const rig = this.rig
		switch ( key ) {

			case 'bend': this.fold.setBend( value ); this._applyFoldTilt(); break
			case 'curl': this.setCurl( value * D2R ); break
			case 'foldStart': this.setFoldStart( value ); break
			case 'foldLength': this.setFoldLength( value ); break
			case 'fov': this.setFov( value ); break
			case 'haze': this.setHaze( value ); break
			case 'sunAzim': this.setSunBearing( value ); break
			case 'sunHeight': this.setSunHeight( value ); break
			case 'clouds': this.setClouds( value ); break
			// Immediate, because the curve in the shot *is* the easing — running
			// it through the rig's damping as well would round off every key.
			case 'height': rig.setHeight( value, { immediate: true } ); break
			case 'pitch': rig.setPitch( value * D2R, { immediate: true } ); break
			case 'yaw': rig.setBearing( state.yaw + value * D2R ); break
			case 'tilt': this.look.tilt.value = value; break
			case 'tiltBand': this.look.tiltBand.value = value; break
			case 'tiltAt': this.look.tiltCenter.value = value; break
			case 'vignette': this.look.vignette.value = value; break
			case 'aberration': this.look.aberration.value = value; break
			case 'glow': this.look.glow.value = value; break
			case 'grade': this.look.grade.value = value; break
			case 'exposure': this.look.exposure.value = value; break
			case 'drift': rig.sway = value; break

		}

	}

	// ------------------------------------------------------------------ fold

	setBend( amount ) {

		this.fold.setBend( MathUtils.clamp( amount, 0, 1 ) )
		this._applyFoldTilt()
		return this

	}

	setShape( shape ) {

		this.fold.setShape( shape )
		return this

	}

	setBearing( bearing ) {

		this.fold.setBearing( bearing )
		this.rig.setBearing( bearing )
		// The sun is authored as an offset from the axis, so it swings with it —
		// a move opened facing any direction is still the lit take.
		this.sky.aim( bearing )
		return this

	}

	_applyFoldTilt() {

		// Eased rather than linear so the lens stays put through the first part
		// of the move, when there is nothing above the frame line yet.
		const t = this.fold.bend
		this.rig.foldTilt = FOLD_TILT * t * t * ( 3 - 2 * t )

	}

	/**
	 * Swaps a freshly loaded tile onto the folding material.
	 *
	 * Every tile that ever appears goes through here, including ones that stream
	 * in while the city is already halfway over — which is why the bend lives in
	 * uniforms shared by all of them rather than in per-material state. A tile
	 * that arrives at t = 0.6 is drawn folded on its first frame.
	 */
	_foldModel( scene ) {

		scene.traverse( object => {

			const source = object.material
			if ( ! source ) return

			// The source material is deliberately left alone rather than
			// disposed here: it is the one the tile renderer wrote down at parse
			// time and will dispose itself. It never reaches the GPU, so it
			// costs a JS object until the tile unloads.
			object.material = foldMaterial( source, this.fold, this.sky )
			this._materials.add( object.material )

		} )

	}

	/**
	 * Pumps the tile pipeline, advancing the LOD crossfades by `dt` real
	 * seconds first.
	 *
	 * `TilesFadePlugin` steps its fades off `performance.now()`, which is right
	 * for a live loop and wrong for both of the other ways this app drives the
	 * world. A recorded frame takes far longer to render than it lasts, so
	 * every fade would clamp to complete inside one captured frame — smooth on
	 * screen, popping in the file. Completing them on every seek is the other
	 * failure: a 420 ms dissolve becomes a hard LOD swap, which is the jump
	 * the recorder used to write. `settle()` has the opposite problem: it
	 * pumps the pipeline for seconds of wall time while the shot stands still,
	 * which would run out the fades of tiles that have not been seen yet.
	 *
	 * The manager derives its step from `now - _lastTick` and clamps it to the
	 * fade duration, so backdating that stamp hands it whatever delta we want
	 * and leaves the rest of the plugin's logic upstream's.
	 *
	 * @param {number} dt Seconds to advance the fade. Negative is always a cut.
	 * @param {boolean} [cut=false] Resolve every in-flight fade before pumping.
	 *   Only `seek()` sets this, and only for discontinuous jumps — never the
	 *   live loop, where a long frame is a hitch rather than a cut.
	 */
	_updateTiles( dt = 0, cut = false ) {

		const manager = this._fadeManager
		if ( manager ) {

			if ( cut || ! ( dt >= 0 ) ) {

				manager.completeAllFades()
				dt = 0

			} else if ( dt > FADE_MAX_STEP ) {

				dt = FADE_MAX_STEP

			}

			manager._lastTick = performance.now() - dt * 1000

		}

		this.tiles.update()
		this.tilesLoading = this.tiles.stats.downloading + this.tiles.stats.parsing

	}

	// --------------------------------------------------------------- capture

	/**
	 * Everything a frame-locked recorder needs, and nothing the live loop uses.
	 *
	 * The move is re-run on a virtual clock: the world is seeked to frame N/fps,
	 * the tile pipeline is given a chance to catch up, and only then is the
	 * frame rendered and handed to the encoder. That decoupling is the point —
	 * the file is smooth at exactly the requested frame rate however long any
	 * one frame took to produce, and every frame gets the geometry it deserves
	 * instead of whatever had streamed in by the time a wall clock reached it.
	 */
	seek( time ) {

		if ( ! this._shot ) return this

		// Real seconds, the clock shake, clouds and the fade all share. Divided
		// by the rate because those three are measured in wall time — `rig.apply`
		// integrates shake with wall-clock `dt`, and a fade duration of 420 ms
		// is 420 ms of the file, not of authored shot time. Feeding them
		// authored time would record a faster tremor than the live loop shows,
		// and would run the crossfade out in four-fifths the frames.
		const realTime = time / SHOT_RATE
		const prev = this._seekRealTime
		this._seekRealTime = realTime
		const realDt = prev == null ? 0 : realTime - prev
		const cut = prev == null || ! ( realDt >= 0 ) || realDt > FADE_CUT_STEP

		this.rig.swayTime = realTime
		this.sky.time.value = realTime
		this._applyShotAt( time )
		this._followCenter()

		// The live loop follows ground from `_tick`. A capture never enters
		// `_tick`, and a dolly writes `rig.x/z` directly, so without this a
		// 600 m authored walk would re-centre the fold on ground it had never
		// measured. On a cut the datum snaps; between consecutive frames it
		// eases on the same shot clock the rest of the pose uses, so a roof
		// edge is not a teleport in the file.
		if ( this.capturing && this.groundProbed ) {

			const strayed = Math.hypot( this.rig.x - this._probedAt.x, this.rig.z - this._probedAt.z )
			if ( strayed > PROBE_STRIDE ) this.followGround()
			if ( cut ) {

				if ( this._groundTarget !== null ) this._setGroundY( this._groundTarget )
				if ( this._floorTop !== null ) {

					this.rig.floorHeight = this._floorTop - this.groundY + CLEARANCE

				}

			} else {

				this._settleGround( realDt )

			}

		}

		this.rig.apply( this.camera )
		this._updateTiles( cut ? 0 : realDt, cut )
		return this

	}

	/**
	 * One frame, outside the animation loop. Tiles have already been pumped
	 * by `seek` or `settle` — rendering here a second time would step the
	 * fade on the wall clock and undo the shot-clock work.
	 */
	renderFrame() {

		this.post.render()
		return this

	}

	/**
	 * True when the pipeline has gone completely quiet. The three queues have
	 * to be checked as well as the counters: a tile can be mid-flight through
	 * node processing without yet showing up as queued, downloading or parsing.
	 */
	isSettled() {

		const { tiles } = this
		const s = tiles.stats
		return tiles.root !== null
			&& tiles.isLoading === false
			&& tiles.downloadQueue.running === false
			&& tiles.parseQueue.running === false
			&& tiles.processNodeQueue.running === false
			&& s.queued === 0 && s.downloading === 0 && s.parsing === 0

	}

	/**
	 * Pumps the tile pipeline until it goes quiet, or until the budget runs out.
	 *
	 * `stableFrames` exists because "quiet" flickers: a tile finishing parsing
	 * can queue its own children in the same update, so a single quiet frame
	 * means nothing and two in a row usually do. Fades are frozen (`dt` 0)
	 * because the shot is standing still while we wait — advancing them here
	 * would dissolve tiles that the next encoded frame has not reached yet.
	 *
	 * `abort` is how Escape punches through: without it the cancelled flag sits
	 * idle until this budget runs out, which for a prime can be twelve seconds.
	 */
	async settle( { maxWaitMs = 8000, stableFrames = 2, abort } = {} ) {

		const deadline = performance.now() + maxWaitMs
		let stable = 0

		while ( performance.now() < deadline ) {

			if ( abort && abort() ) return false
			this._updateTiles( 0 )
			stable = this.isSettled() ? stable + 1 : 0
			if ( stable >= stableFrames ) return true
			// The tile queues schedule their own work through rAF, so yielding
			// is what actually lets a download land. Sixteen milliseconds rather
			// than a bare `0`: a zero timeout can starve the rAF the queues
			// wait on, and the sibling project's settle uses the same slice.
			await new Promise( resolve => setTimeout( resolve, 16 ) )

		}

		return this.isSettled()

	}

	/**
	 * Renders at an exact pixel size for the duration of a capture.
	 *
	 * `_sized` is deliberately left alone: the loop's self-healing resize
	 * compares against it, and if it matched the capture size the first live
	 * frame after a recording would not put the window size back.
	 */
	setCaptureSize( width, height, pixelRatio = 1 ) {

		this.capturing = true
		this.renderer.setPixelRatio( pixelRatio )
		this.renderer.setSize( width, height, false )
		this.camera.aspect = width / height
		this.camera.updateProjectionMatrix()
		this.tiles.setResolutionFromRenderer( this.camera, this.renderer )
		return this

	}

	restoreSize() {

		this.capturing = false
		this.renderer.setPixelRatio( Math.min( window.devicePixelRatio, MAX_PIXEL_RATIO ) )
		this._sized = 0
		return this.resize()

	}

	// ------------------------------------------------------------------ loop

	start() {

		if ( this._running ) return this
		this._running = true
		this._lastTime = 0
		this.renderer.setAnimationLoop( time => this._tick( time ) )
		return this

	}

	stop() {

		this._running = false
		this.renderer.setAnimationLoop( null )
		return this

	}

	_tick( time ) {

		const seconds = time / 1000
		const dt = this._lastTime ? Math.min( seconds - this._lastTime, 0.1 ) : 1 / 60
		this._lastTime = seconds

		// Resize from the loop rather than only from the event. A pane that was
		// collapsed when the page loaded never fires `resize` on its way back,
		// and the renderer would sit on a swapchain built for a window that no
		// longer exists — black, permanently, with no error after the first one.
		if ( ! this.capturing && window.innerWidth * 100000 + window.innerHeight !== this._sized ) this.resize()

		this.rig.update( dt )
		this.sky.time.value += dt
		// After the rig's own damping and before the camera is built from it,
		// so an authored key lands exactly on the frame it was authored for.
		this._advanceShot( dt )
		// Before the tile pump, so the loader camera asks for the disc the
		// camera is standing in now rather than the one it left last frame.
		this._followCenter()
		this.rig.apply( this.camera )

		this._updateTiles( dt )
		this.tilesVisible = this.tiles.visibleTiles.size

		const quiet = this.tilesLoading === 0 && this.tiles.stats.queued === 0

		// The probe keeps answering, and keeps being overruled, until the tile
		// pipeline goes quiet. A single early answer is worth nothing: the first
		// mesh under the origin is a continent-wide shell, and in Paris it reads
		// 40 m high. Only the last answer, taken once nothing is still
		// refining, is the street.
		if ( ! this.groundProbed && seconds > this._probeAt && this.tilesVisible > 0 ) {

			// Ray-casting the active set is not free, so it is asked a couple of
			// times a second rather than every frame.
			this._probeAt = seconds + 0.4
			this._probeTries ++
			// Under the camera, not the frame origin. A restored walk is
			// already somewhere else, and the origin is then a different street
			// — measuring it would set the datum to the arrival pavement and
			// treat the hill the lens is on as building height.
			const probe = this.probeGround( { x: this.rig.x, z: this.rig.z } )
			if ( probe ) {

				this._hasGround = true
				this._setGroundY( probe.ground )
				this._groundTarget = probe.ground
				// After `_setGroundY`, not before: the clearance is a height
				// above the pavement, and the pavement is what just changed.
				if ( probe.top !== null ) {

					this._floorTop = probe.top
					this.rig.floorHeight = probe.top - probe.ground + CLEARANCE

				}

			}

			// A timeout can settle a previously measured street, but it must never
			// make the CTA available when every ray still misses the loaded mesh.
			this.groundProbed = this._hasGround && ( quiet || this._probeTries > 90 )
			// Only once the pavement is the real pavement — the open-ground
			// search compares against it, so running it early walks the camera
			// to whatever looked lowest on the coarse shell. And only if the
			// viewer has not already walked off under their own steam.
			if ( this.groundProbed && probe && this.rig.x === 0 && this.rig.z === 0 ) {

				this.findOpenGround()

			}

		}

		if ( this.state === 'loading' && quiet && this.tilesVisible > 0 ) this._setState( 'ready' )

		// Crossing roofs, courtyards and hills invalidates both the clearance
		// and the fold's own datum, and this is keyed on *having moved* rather
		// than on the keys being held. A shot's dolly writes `rig.x/z` directly
		// and never sets `_walking`, so gating on the keys meant a 600 m move
		// re-centred the fold on ground it had never measured — the datum bug
		// again, arriving by a different door.
		const strayed = Math.hypot( this.rig.x - this._probedAt.x, this.rig.z - this._probedAt.z )
		if ( this.groundProbed && strayed > PROBE_STRIDE && seconds > this._followAt ) {

			this._followAt = seconds + 0.12
			this.followGround()

		}

		this._settleGround( dt )

		this.post.render()

		if ( this.onFrame ) this.onFrame( dt )

	}

	/**
	 * A zero-sized window is refused, not passed on.
	 *
	 * A minimised window, a collapsed pane, a tab hidden at the wrong moment —
	 * any of them can report `innerWidth` 0, and handing that to `setSize` asks
	 * WebGPU for a swapchain texture of size 0. It refuses, the texture is
	 * invalid, and every render after it fails validation against that same
	 * invalid view: the canvas goes black and *stays* black long after the
	 * window has a size again, because nothing re-creates the swapchain. It
	 * looks exactly like a scene that failed to load, which is how it cost an
	 * afternoon. Skipping the resize entirely leaves the last good swapchain in
	 * place, and the next real one puts it right.
	 */
	resize() {

		const width = window.innerWidth
		const height = window.innerHeight
		if ( width < 1 || height < 1 ) return this

		this._sized = width * 100000 + height
		this.camera.aspect = width / height
		this.camera.updateProjectionMatrix()
		this.renderer.setSize( width, height )
		this.tiles.setResolutionFromRenderer( this.camera, this.renderer )
		return this

	}

	/** Never zero and never NaN, so a collapsed window cannot reach the camera. */
	_aspect() {

		return Math.max( window.innerWidth, 1 ) / Math.max( window.innerHeight, 1 )

	}

	_setState( state ) {

		if ( this.state === state ) return
		this.state = state
		if ( this.onStateChange ) this.onStateChange( state )

	}

}
