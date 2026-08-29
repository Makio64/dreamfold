/**
 * The sky: a gradient and a sun — in TSL, because everything the sibling
 * project does this with (`@takram/three-clouds`, `postprocessing`) is GLSL
 * patched through onBeforeCompile, which a node material never calls. Under
 * WebGPU those libraries fail silently, so the sky is rebuilt here from the
 * pieces three ships as nodes.
 *
 * The load-bearing arrangement is that `skyColor` is *one function with two
 * callers*: the scene's `backgroundNode` samples it along the pixel ray, and
 * the haze in `foldMaterial` samples it along the ray to the bent fragment —
 * the same ray, for the same pixel. A tile at full haze therefore comes out
 * identical to the sky behind it, and the rim of the loaded disc stays
 * invisible wherever the fold puts it. That is the old flat-colour invariant
 * ("the sky is `fold.fogColor` itself") generalised: the sky can now vary, but
 * the haze varies with it by construction rather than by matching.
 *
 * The clouds are not here. They are a raymarched volume (`clouds.js`), folded
 * with the city by inverting the bend per sample, reading their sun and
 * weather from the `SkyState` below. Their density dissolves inside the same
 * haze band the tiles do, which is what keeps this function cloud-free
 * without ever letting a cloud touch the rim.
 *
 * `fold.fogColor` stays the root of the palette — the horizon is that colour
 * exactly, and the zenith and the cloud shading are derived from it — so the
 * one colour control still moves the whole picture coherently.
 */

import { Color, MathUtils, Vector3 } from 'three'
import { dot, max, mix, pow, smoothstep, uniform, vec3 } from 'three/tsl'

const D2R = MathUtils.DEG2RAD

/**
 * The sun's palette by elevation: overhead it is barely warm, on the horizon it
 * is molten gold. Solved on the CPU per change of angle rather than per fragment.
 */
const SUN_HIGH = new Color( 1.0, 0.96, 0.9 )
const SUN_LOW = new Color( 1.0, 0.58, 0.28 )

/**
 * The sun and the weather, as uniforms every sky sample reads.
 *
 * The sun is aimed *relative to the fold axis* — `offset` degrees off the
 * bearing the hinge runs along — rather than at a compass point. Every other
 * authored thing here is relative (shots to the yaw they opened on, the fold to
 * the bearing it was given), and a sun that stayed on absolute north would sit
 * behind the camera in half the cities and flat side-on in the rest. The
 * default key is the sibling project's Golden preset — eight degrees up,
 * forty-six off the subject: a low warm key, ahead enough to silhouette the
 * rising street, off enough that the frame centre is not a white hole.
 */
export class SkyState {

	constructor( fold ) {

		this.fold = fold

		this.sunDir = uniform( new Vector3( 0, 0.3, - 0.95 ) )
		this.sunColor = uniform( new Color() )
		this.coverage = uniform( 0.3 )

		// Cloud drift. Advanced by the live loop's dt and *seeked* by the
		// recorder, exactly like `rig.swayTime`: a capture renders slower than
		// real time, so clouds on the wall clock would crawl and stutter in the
		// file while looking fine on screen.
		this.time = uniform( 0 )

		this.bearing = 0
		this.offset = 46 * D2R
		this.elevation = 8 * D2R
		this.aim( 0 )

	}

	/** Re-aims the sun against a new fold bearing, keeping the authored offset. */
	aim( bearing ) {

		if ( bearing !== undefined ) this.bearing = bearing

		const azimuth = this.bearing + this.offset
		const cosEl = Math.cos( this.elevation )
		// +x east, +z south: a compass bearing β points along ( sin β, −cos β ).
		this.sunDir.value.set(
			Math.sin( azimuth ) * cosEl,
			Math.sin( this.elevation ),
			- Math.cos( azimuth ) * cosEl,
		).normalize()

		const warmth = MathUtils.smoothstep( this.elevation / D2R, 3, 30 )
		this.sunColor.value.lerpColors( SUN_LOW, SUN_HIGH, warmth )
		return this

	}

	setOffset( radians ) {

		this.offset = radians
		return this.aim()

	}

	setElevation( radians ) {

		this.elevation = radians
		return this.aim()

	}

}

/**
 * The colour of the sky along a ray.
 *
 * `disc` gates the sun's own disc, which only the background draws: the haze
 * samples everything else — gradient and glow — so a half-hazed facade that
 * happens to line up with the sun does not grow a ghost sun. The disc is under
 * a degree wide and the glow spans the gap, so the rim crossing it has nothing
 * to catch on.
 *
 * The disc and the heart of the glow are authored past 1.0 on purpose. The
 * scene renders to half-float, and everything over white is what the bloom
 * pass in `World._initPost` is thresholded to pick up — the sun blooms, the
 * lit cloud rims bloom faintly, and the city (photographed, so never over
 * white) stays crisp.
 *
 * Like `bendPosition`, deliberately not wrapped in `Fn`: two callsites, and
 * inline uniforms read clearer than a struct layout.
 */
export function skyColor( ray, sky, { disc = false } = {} ) {

	const fog = sky.fold.fogColor

	// The gradient starts a few degrees up so the horizon itself is exactly
	// `fogColor` all the way round — the haze band lands on it seamlessly and
	// the band the rim used to be found in is a band that no longer exists.
	// The zenith rides the root's *luminance* rather than its channels: a warm
	// swatch multiplied by a blue tint lands on tan — a ceiling the colour of
	// the pavement — while luminance keeps the one swatch driving the whole
	// sky's brightness and overhead stays sky-blue whatever the horizon does.
	// The tint's blue stops at 1 so no swatch, however pale, can push the
	// zenith past the bloom threshold. Blue arrives by twenty-five degrees up,
	// the way a clear summer sky is blue almost to the rooftops: a level frame
	// then holds a blue sky over a bright skyline instead of filling with the
	// horizon band alone.
	const zenith = dot( fog, vec3( 0.2126, 0.7152, 0.0722 ) ).mul( vec3( 0.3, 0.54, 1.0 ) )
	const gradient = mix( fog, zenith, smoothstep( 0.03, 0.42, ray.y ) )

	const cosSun = dot( ray, sky.sunDir )
	const toSun = max( cosSun, 0 )
	// Narrower than it wants to be. The haze paints this same glow across every
	// fully fogged tile, and the fold can fill half the frame with those — a
	// generous base term read as a white-out the moment the city rose in front
	// of the sun.
	const glow = pow( toSun, 14 ).mul( 0.42 ).add( pow( toSun, 5 ).mul( 0.1 ) )
	const lit = gradient.add( sky.sunColor.mul( glow ) )

	if ( ! disc ) return lit

	// cos 1.7° to cos 0.9°: a soft-edged disc twice the real sun. The folded
	// cloud deck is geometry and draws over it, so a cloud crossing the sun
	// dims it the same way a building does.
	const core = smoothstep( 0.99956, 0.99988, cosSun )
	return lit.add( sky.sunColor.mul( core.mul( 3 ) ) )

}
