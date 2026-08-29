import {
	BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality,
	WebMOutputFormat, canEncodeVideo, getFirstEncodableVideoCodec,
} from 'mediabunny'
import { SHOT_RATE } from '../camera/shots.js'

/**
 * Frame-locked capture.
 *
 * The move is re-run on a virtual clock rather than the wall clock: the world
 * is seeked to frame N/fps, the tile pipeline is given a chance to catch up,
 * the frame is rendered and handed straight to a hardware video encoder. That
 * decoupling is the whole point — the export is smooth at exactly the requested
 * frame rate no matter how long any individual frame took to produce, and every
 * frame gets the geometry it deserves instead of whatever had streamed in by
 * the time the clock reached it. A move that stutters live records clean.
 *
 * `CanvasSource.add()` snapshots the canvas and then resolves once the encoder
 * and muxer have room, which makes awaiting it both the frame grab and the
 * backpressure valve. Nothing may await between `renderFrame()` and `add()`, or
 * the drawing buffer will already have been handed back.
 *
 * Ported from threejs-cinematic-world-zoom, which records the opposite end of
 * the same flight. The differences are all downstream of WebGPU: there is no
 * exposure to meter, and the canvas is read through `drawImage` because a
 * WebGPU drawing buffer cannot be handed to the encoder directly.
 *
 * Tile LOD fades ride the same virtual clock. Completing them per seek made
 * every refinement a hard swap in the file; leaving them on `performance.now()`
 * collapsed a 420 ms dissolve into whichever frame took longest to encode.
 * `World.seek` steps them by `1/fps` and `settle` freezes them, so a capture
 * gets the same crossfade as a live move.
 */

const RESOLUTIONS = { 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }

/**
 * The live preview renders at up to `MAX_PIXEL_RATIO` and the browser
 * downsamples into the CSS box — that is most of the antialiasing the eye
 * actually sees. A capture forced to ratio 1 looks crunchy next to the same
 * move on screen, so the drawing buffer is supersampled and bilinearly resolved
 * into the encode canvas. These factors are the capture's own and deliberately
 * do not follow the preview's ceiling: a file is looked at once and rendered
 * offline, so it can afford the samples the interactive frame cannot. Capped so
 * a 4K export does not become an 8K render.
 */
const CAPTURE_SUPER_SAMPLE = 2
const SUPER_SAMPLE = { fast: 1, balanced: CAPTURE_SUPER_SAMPLE, best: CAPTURE_SUPER_SAMPLE }

/**
 * The long edge the supersample is allowed to reach, above which the factor
 * steps down instead of the render getting bigger. It has to sit at
 * `CAPTURE_SUPER_SAMPLE` × the largest resolution that should get the full
 * factor: at 3840 a 1440p file quietly came out at 1.5× and a 4K one at 1×,
 * which is the cap silently deciding the quality the ladder was asked for.
 * 5120 gives 720p, 1080p and 1440p their whole 2×; 4K still steps down, and
 * deliberately — every full-frame target in the chain is sized off this, and
 * a cloud march, a gaussian and a bloom ladder at 7680 wide is where the
 * exporter stops being an exporter and starts being an out-of-memory error.
 */
const SUPER_SAMPLE_MAX_LONG = 5120

/** H.264 and HEVC reject odd dimensions outright. */
const even = value => Math.round( value / 2 ) * 2

function capturePixelRatio( width, height, quality ) {

	const wanted = SUPER_SAMPLE[ quality ] ?? 2
	if ( wanted <= 1 ) return 1
	return Math.min( wanted, SUPER_SAMPLE_MAX_LONG / Math.max( width, height ) )

}

export function captureSize( { resolution = 1080, aspect = 16 / 9 } = {} ) {

	// The named resolution is the long edge, so a vertical frame keeps the same
	// pixel budget instead of becoming a postage stamp — and 1080p scope comes
	// out exactly 1920 wide rather than 1922.
	const long = RESOLUTIONS[ resolution ] || 1920
	const size = aspect >= 1
		? { width: even( long ), height: even( long / aspect ) }
		: { width: even( long * aspect ), height: even( long ) }
	// Two pixels is the smallest thing an even-dimension codec will take.
	size.width = Math.max( size.width, 2 )
	size.height = Math.max( size.height, 2 )
	return size

}

export async function bestCodec( { width, height } ) {

	const codec = await getFirstEncodableVideoCodec( [ 'avc', 'hevc', 'av1', 'vp9' ], {
		width, height, quality: new Quality( 'high' ),
	} )
	if ( codec !== null ) return codec
	return ( await canEncodeVideo( 'vp8', { width, height } ) ) ? 'vp8' : null

}

export class Recorder {

	constructor( world ) {

		this.world = world
		this.active = false
		this.cancelled = false
		this.result = null

	}

	cancel() {

		this.cancelled = true

	}

	/**
	 * @param {object} opts
	 * @param {string} opts.shot Which move to record.
	 * @param {number} opts.resolution 720 | 1080 | 1440 | 2160, the long edge.
	 * @param {number} opts.fps
	 * @param {'fast'|'balanced'|'best'} opts.quality How long the tiles get to
	 *   catch up before each frame is committed.
	 * @param {(info: object) => void} [opts.onProgress]
	 */
	async record( {
		shot = 'fold',
		resolution = 1080,
		fps = 30,
		quality = 'balanced',
		onProgress,
	} = {} ) {

		const { world } = this
		if ( this.active ) return null
		if ( ! world.groundProbed ) throw new Error( 'Wait for the city to finish loading.' )

		// A hidden or collapsed window records a perfectly valid file of nothing.
		// The canvas can only be read inside the same task as the render that
		// filled it, and a browser that is not compositing this page does not
		// give that render anywhere to land — so the encode succeeds, the frames
		// are flat sky, and the only clue is a suspiciously small file. Refuse
		// instead, and say why.
		if ( window.innerWidth < 2 || window.innerHeight < 2 || document.hidden ) {

			throw new Error( 'Bring this window to the front before recording.' )

		}

		this.active = true
		this.cancelled = false
		this.result = null

		const wasRunning = world._running
		let output = null
		let captureStarted = false

		try {

			// Taken from the window, but not trusted to it. A collapsed or hidden
			// pane reports zero, and an aspect of zero makes a capture zero
			// pixels wide — which the encoder rejects with a message about
			// integers that says nothing about where the zero came from.
			const live = window.innerWidth / Math.max( window.innerHeight, 1 )
			const { width, height } = captureSize( {
				resolution,
				aspect: live > 0.2 && live < 5 ? live : 16 / 9,
			} )
			const codec = await bestCodec( { width, height } )
			if ( this.cancelled ) return null
			if ( codec === null ) throw new Error( 'This browser cannot encode video at that size.' )

			const usesMp4 = codec !== 'vp8'
			const pixelRatio = capturePixelRatio( width, height, quality )
			// Per-frame patience. `best` waits for the pipeline to go quiet on
			// every single frame; `fast` never waits and takes what has streamed.
			const settleBudget = quality === 'best' ? 2500 : quality === 'balanced' ? 220 : 0
			const abort = () => this.cancelled

			// The recorder owns the loop while it runs. Two of them fighting over
			// the drawing buffer produces torn frames.
			world.stop()
			world.playShot( shot )
			if ( ! world._shot ) throw new Error( 'That move could not be started.' )

			// `end` and `from` are authored seconds; the file is measured in
			// real ones, so the span between them is divided by the playback rate
			// to decide how many frames the move is worth. `end` is the last
			// arriving key, not `shot.duration` — duration often holds a rest
			// after the pose has landed, and encoding that rest is extra video
			// of a picture that has already stopped changing.
			const duration = world._shot.shot.duration
			const from = world._shot.time
			const end = world._shot.end ?? duration
			const span = Math.max( ( end - from ) / SHOT_RATE, 1 / fps )
			const totalFrames = Math.max( 1, Math.round( span * fps ) )
			const frameDuration = 1 / fps

			world.setCaptureSize( width, height, pixelRatio )
			captureStarted = true
			this._tuneTilesForCapture()

			// Encode from a 1× canvas. When the world is supersampled each frame
			// is drawn down into this before `add()`. A WebGPU drawing buffer
			// cannot be handed to the encoder directly, so even a 1× capture
			// copies through 2d.
			const encodeCanvas = typeof OffscreenCanvas !== 'undefined'
				? new OffscreenCanvas( width, height )
				: Object.assign( document.createElement( 'canvas' ), { width, height } )
			const encodeCtx = encodeCanvas.getContext( '2d', { alpha: false } )

			const target = new BufferTarget()
			output = new Output( {
				format: usesMp4 ? new Mp4OutputFormat( { fastStart: 'in-memory' } ) : new WebMOutputFormat(),
				target,
			} )
			const source = new CanvasSource( encodeCanvas, {
				codec,
				quality: new Quality( 'high' ),
				keyFrameInterval: 1,
				latencyMode: 'quality',
				sizeChangeBehavior: 'deny',
				...( codec === 'avc' ? { fullCodecString: 'avc1.640033' } : {} ),
			} )
			output.addVideoTrack( source, { frameRate: fps } )
			await output.start()
			if ( this.cancelled ) {

				await output.cancel()
				return null

			}

			const started = performance.now()

			const commitFrame = () => {

				// Nothing may await between these two lines.
				world.renderFrame()
				encodeCtx.drawImage( world.renderer.domElement, 0, 0, width, height )

			}

			// Prime the pipeline at the far end of the move first. The last frame
			// is the one that needs the most city — the fold has brought what was
			// behind the camera over the top of it — so loading that first means
			// every earlier frame is asking for a subset of what is already there.
			world.seek( duration )
			commitFrame()
			await world.settle( { maxWaitMs: quality === 'fast' ? 1500 : 12000, abort } )
			if ( this.cancelled ) {

				await output.cancel()
				return null

			}

			world.seek( from )
			commitFrame()
			await world.settle( { maxWaitMs: quality === 'fast' ? 1500 : 12000, abort } )
			if ( this.cancelled ) {

				await output.cancel()
				return null

			}

			for ( let frame = 0; frame < totalFrames; frame ++ ) {

				if ( this.cancelled ) break

				// Back into authored time, which is what `seek` samples in.
				const time = Math.min( end, from + frame * SHOT_RATE / fps )
				world.seek( time )

				if ( settleBudget > 0 && ! world.isSettled() ) {

					await world.settle( { maxWaitMs: settleBudget, stableFrames: 2, abort } )
					world.seek( time )

				}

				if ( this.cancelled ) break

				commitFrame()
				await source.add( frame / fps, frameDuration )

				if ( onProgress ) onProgress( {
					frame: frame + 1,
					totalFrames,
					elapsed: ( performance.now() - started ) / 1000,
				} )

			}

			if ( this.cancelled ) {

				await output.cancel()
				return null

			}

			await output.finalize()

			this.result = {
				blob: new Blob( [ target.buffer ], { type: usesMp4 ? 'video/mp4' : 'video/webm' } ),
				extension: usesMp4 ? 'mp4' : 'webm',
				width, height, fps, codec,
				duration: totalFrames / fps,
			}
			return this.result

		} catch ( error ) {

			if ( output ) {

				try {

					await output.cancel()

				} catch {}

			}
			throw error

		} finally {

			this.active = false
			this._restoreTiles()
			world.stopShot()
			if ( captureStarted ) world.restoreSize()
			if ( wasRunning ) world.start()

		}

	}

	_tuneTilesForCapture() {

		const { tiles } = this.world
		this._saved = {
			errorTarget: tiles.errorTarget,
			maxBytes: tiles.lruCache.maxBytesSize,
			minBytes: tiles.lruCache.minBytesSize,
			parseJobs: tiles.parseQueue.maxJobs,
		}

		// LOD fades stay on: World._updateTiles() advances TilesFadePlugin on
		// the shot clock, so a fixed-timestep capture gets the same crossfade
		// as a live move instead of a wall-clock slam or a hard pop.

		tiles.errorTarget = 8
		tiles.lruCache.minBytesSize = 1.2 * 2 ** 30
		tiles.lruCache.maxBytesSize = 1.8 * 2 ** 30
		tiles.parseQueue.maxJobs = 10

	}

	_restoreTiles() {

		const { tiles } = this.world
		const saved = this._saved
		if ( ! saved ) return
		tiles.errorTarget = saved.errorTarget
		tiles.lruCache.maxBytesSize = saved.maxBytes
		tiles.lruCache.minBytesSize = saved.minBytes
		tiles.parseQueue.maxJobs = saved.parseJobs
		this._saved = null

	}

}

export function downloadRecording( result, name = 'dreamfold' ) {

	if ( ! result ) return
	const url = URL.createObjectURL( result.blob )
	const link = document.createElement( 'a' )
	link.href = url
	link.download = `${name}-${result.width}x${result.height}.${result.extension}`
	document.body.appendChild( link )
	link.click()
	link.remove()
	// Revoking immediately races the download in some browsers.
	setTimeout( () => URL.revokeObjectURL( url ), 60_000 )

}
