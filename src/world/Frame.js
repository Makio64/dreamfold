import { Matrix4, Vector3 } from 'three'

import { getEastNorthUpAxes } from '../geo.js'

/**
 * The local frame everything downstream of the tile loader works in.
 *
 * 3D Tiles are delivered in ECEF: metres from the centre of the Earth, so every
 * coordinate in the payload is around 6.4e6. A float32 holds about seven
 * significant digits, which leaves roughly half a metre of resolution at that
 * magnitude — fine for a globe seen from orbit, useless for a camera standing
 * on a pavement, and actively broken for a vertex shader that has to bend the
 * pavement smoothly.
 *
 * So the whole city is moved to the origin. `Frame` is the rigid transform from
 * ECEF into a local East-Up-South basis at the chosen street corner:
 *
 *   +x  east
 *   +y  up      (ellipsoidal height, because the origin sits on the ellipsoid)
 *   +z  south
 *
 * It is installed on `tiles.group`, so three composes it with each tile's own
 * ECEF transform *on the CPU, in float64*, and what reaches the GPU is a model
 * matrix whose translation is a few hundred metres. The big numbers are spent
 * once, in double precision, and never appear in a shader.
 *
 * East-Up-South rather than the East-North-Up the ellipsoid speaks is just the
 * handedness three wants: with +x east and +y up, the third axis of a
 * right-handed basis is x × y = east × up = −north. An unrotated camera looks
 * down −z, which is therefore due north.
 *
 * Treating this frame as flat costs d²/2R of Earth curvature at distance d:
 * 8 cm at a kilometre, 2.8 m at six. The fold reaches a couple of kilometres
 * and the walk is capped at six (see `MAX_WALK`), so the worst case is a few
 * metres over a horizon that is already hazed out. The tiles keep their real
 * curvature regardless; it is only the fold axis that is taken as straight.
 */
export class Frame {

	constructor( ellipsoid, lat, lon ) {

		this.ellipsoid = ellipsoid
		this.lat = lat
		this.lon = lon

		const east = new Vector3()
		const north = new Vector3()
		const up = new Vector3()
		getEastNorthUpAxes( ellipsoid, lat, lon, east, north, up )

		this.origin = ellipsoid.getCartographicToPosition( lat, lon, 0, new Vector3() )
		this.east = east
		this.up = up
		this.south = north.clone().negate()

		/** local → ECEF */
		this.toEcef = new Matrix4().makeBasis( east, up, this.south ).setPosition( this.origin )

		/** ECEF → local. Rigid, so the inverse is exact up to float64 rounding. */
		this.toLocal = this.toEcef.clone().invert()

	}

	/**
	 * Local position of a geographic point. `height` is ellipsoidal, matching
	 * the frame's own +y at the origin.
	 */
	fromCartographic( lat, lon, height, target = new Vector3() ) {

		this.ellipsoid.getCartographicToPosition( lat, lon, height, target )
		return target.applyMatrix4( this.toLocal )

	}

	/** Ground distance from the frame origin to a geographic point, in metres. */
	distanceTo( lat, lon ) {

		const point = this.fromCartographic( lat, lon, 0, _scratch )
		return Math.hypot( point.x, point.z )

	}

}

const _scratch = new Vector3()
