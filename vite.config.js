import { defineConfig } from 'vite'

const TILE_CREDENTIAL_BUILD_MODE = 'embed-tile-credentials'
const TILE_CREDENTIAL_ENV_KEYS = [ 'VITE_ION_TOKEN', 'VITE_GOOGLE_API_KEY' ]

export default defineConfig( ( { command, mode } ) => {

	const exposeTileCredentials = command === 'serve' || mode === TILE_CREDENTIAL_BUILD_MODE

	return {
		// Only these two VITE_* values may cross the client boundary, and never in
		// a normal build. The alternate prefix matches nothing used by this app.
		envPrefix: exposeTileCredentials ? TILE_CREDENTIAL_ENV_KEYS : 'DREAMFOLD_PUBLIC_',
		server: {
			// PORT lets a second workspace (another agent session, a CI preview)
			// run alongside the one already holding 5181.
			port: Number( process.env.PORT ) || 5181,
		},
		optimizeDeps: {
			include: [ 'three', 'three/webgpu', 'three/tsl', '3d-tiles-renderer' ],
		},
	}

} )
