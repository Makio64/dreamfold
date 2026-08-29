import { DESTINATIONS, coordDestination, parseLocation } from '../data/destinations.js'
import { MAX_HEIGHT, MIN_HEIGHT } from '../camera/Rig.js'
import { FOLD_SHAPES, SHAPE_LIST } from '../world/fold.js'
import { DEFAULT_SHOT, SHOTS, sampleTrack } from '../camera/shots.js'
import { captureSize } from '../record/Recorder.js'

/**
 * All of the DOM.
 *
 * Nothing here knows what a tile or a fold is. It reads the markup in
 * index.html, hands intent out through `on.*`, and takes state back in through
 * the setters — so `main.js` stays wiring and the world stays renderer.
 */

const LAST_PLACE = 'dreamfold.place'
const LAST_SESSION = 'dreamfold.session'

/** How long a spinner runs before the card admits the service is slow. */
const KEY_SLOW_MS = 4000

/** How long a rejection stays under the field before it takes itself away. */
const KEY_NOTICE_MS = 5000

/**
 * What a refusal actually means, in words somebody can act on.
 *
 * `tilesAuth` reports what the service said; this turns each of those into the
 * next thing to do. The first entry is the one that matters most: a brand new
 * Cesium account has no 3D tiles on it, and generic "check you copied it"
 * advice sends somebody round the same loop again.
 */
const KEY_REASONS = [
	{
		test: /did not return a tileset URL/,
		text: 'That Cesium account needs the 3D map first. Add “Google Photorealistic 3D Tiles”, then try the key again.',
		href: 'https://ion.cesium.com/assetdepot/2275207',
		label: 'Add it on Cesium ↗',
	},
	{
		test: /rejected that token/,
		text: 'Cesium did not recognise that key. Check the whole line was copied.',
	},
	{
		// A live root refused, and neither tilesAuth nor this table knows whose
		// root it was: naming Cesium here would be wrong for every Google key.
		test: /rejected this key/,
		text: 'The map service refused that key. If it is a Google key, check the Map Tiles API is on and this site is allowed.',
	},
	{
		test: /Google key was rejected/,
		text: 'Google rejected that key. Check the Map Tiles API is on and that this site is allowed.',
		href: 'https://developers.google.com/maps/documentation/tile/get-api-key',
		label: 'Google key setup ↗',
	},
	{
		test: /did not respond in time|Could not reach the tile service/,
		text: 'The map service did not answer. Check your connection and try again.',
	},
]

function keyReason( message, quota ) {

	if ( ! message ) return { text: '' }
	if ( quota ) {

		return { text: 'That key has hit its 3D map limit. The key itself is fine — try another one, or come back later.' }

	}

	const match = KEY_REASONS.find( reason => reason.test.test( message ) )
	return match ? { text: match.text, href: match.href, label: match.label } : { text: message }

}

/** What each cycling button walks through, and what it calls each step. */
const STANCE_LABELS = { street: 'In the street', rooftop: 'Over the roofs', high: 'Higher' }

/**
 * The three popovers in the bar, by the name their open class is built from.
 *
 * Opening any one closes the others and the settings drawer. There is only
 * ever one surface over the picture, because the picture is what all three of
 * them are for.
 */
const MENUS = [ 'shapes', 'moves', 'heights' ]
const MENU_NODES = {
	shapes: { panel: 'shapes', trigger: 'optShape' },
	moves: { panel: 'moves', trigger: 'optMove' },
	heights: { panel: 'heights', trigger: 'optHeight' },
}

/** The height slider is logarithmic: one notch is a ratio, not a number of metres. */
const HEIGHT_SPAN = Math.log( MAX_HEIGHT / MIN_HEIGHT )
const heightFromSlider = value => MIN_HEIGHT * Math.exp( Number( value ) / 1000 * HEIGHT_SPAN )
const heightToSlider = metres => Math.round(
	Math.log( Math.max( metres, MIN_HEIGHT ) / MIN_HEIGHT ) / HEIGHT_SPAN * 1000,
)
const formatHeight = metres => metres < 100
	? `${metres.toFixed( 1 )} m`
	: `${Math.round( metres )} m`

/**
 * The art-direction panel, as data.
 *
 * This many sliders is enough hand-written markup to start diverging from itself —
 * one row with the wrong label, one output that never updates — so the rows are
 * built from here and `main.js` gets `( key, value )` back. `format` is what the
 * readout says; the value handed on is always the raw number.
 */
const LOOK_CONTROLS = [
	{
		key: 'foldStart', label: 'Fold at', min: 20, max: 1600, step: 10, value: 1600,
		format: v => `${Math.round( v )} m`,
	},
	{
		// Not a second bend, though the shader cannot tell them apart: `Bend` is
		// how far round the city has come and this is how much ground that costs.
		// It only goes down from the house length — see `FOLD_LENGTH` in
		// `World.js`, which this row has to agree with.
		key: 'foldLength', label: 'Fold over', min: 20, max: 1900, step: 10, value: 1900,
		format: v => `${Math.round( v )} m`,
	},
	{
		key: 'curl', label: 'Curl', min: 20, max: 300, step: 1, value: 90,
		format: v => `${Math.round( v )}°`,
	},
	{
		key: 'fov', label: 'Lens', min: 24, max: 118, step: 1, value: 69,
		format: v => `${Math.round( v )}°`,
	},
	{
		key: 'haze', label: 'Haze', min: 0.25, max: 1.2, step: 0.01, value: 1.1,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		// Off the fold axis, not off north: the light is authored against the
		// shot, and swings with the bearing so every take opens lit the same
		// way. The base numbers are the sibling project's Golden preset — a low
		// warm key, forty-six degrees off the subject — because that grade of
		// light is the whole reason its frames look the way they do.
		key: 'sunAzim', label: 'Sun at', min: - 180, max: 180, step: 1, value: 46,
		format: v => `${Math.round( v )}°`,
	},
	{
		key: 'sunHeight', label: 'Sun height', min: 2, max: 60, step: 0.5, value: 8,
		format: v => `${Math.round( v )}°`,
	},
	{
		key: 'clouds', label: 'Clouds', min: 0, max: 1, step: 0.01, value: 0.3,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		key: 'tilt', label: 'Tilt-shift', min: 0, max: 1, step: 0.01, value: 0.15,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		// How tall the strip that stays sharp is, as a fraction of frame height
		// each way from the band's centre.
		key: 'tiltBand', label: 'Sharp band', min: 0.02, max: 0.5, step: 0.01, value: 0.16,
		format: v => `${Math.round( v * 200 )}%`,
	},
	{
		// Where that strip sits, measured down from the top of frame. The one
		// worth reaching for while a move runs: the horizon is not where it was
		// a moment ago, and the sharp band is only doing its job if it is on it.
		key: 'tiltAt', label: 'Band at', min: 0, max: 1, step: 0.01, value: 0.52,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, value: 0.2,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		key: 'aberration', label: 'Fringing', min: 0, max: 1, step: 0.01, value: 0.05,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		key: 'glow', label: 'Glow', min: 0, max: 1.5, step: 0.01, value: 0.5,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		key: 'grade', label: 'Grade', min: 0, max: 1, step: 0.01, value: 0.5,
		format: v => `${Math.round( v * 100 )}%`,
	},
	{
		key: 'exposure', label: 'Exposure', min: 0.5, max: 1.6, step: 0.01, value: 1,
		format: v => `${v.toFixed( 2 )}×`,
	},
	{
		key: 'drift', label: 'Shake', min: 0, max: 5, step: 0.05, value: 0,
		format: v => v.toFixed( 2 ),
	},
]

/**
 * The authored base look, frozen apart from `ui.values`.
 *
 * `ui.values` is live state and gets written by everything — a shape button
 * sets the curl, a stance moves the focus. Reading the base back out of it
 * means reading whatever happened last, so the two are kept separate: this is
 * what the sliders open on and what a destination change returns to.
 */
export const BASE_LOOK = Object.freeze(
	Object.fromEntries( LOOK_CONTROLS.map( c => [ c.key, c.value ] ) ),
)

export { LOOK_CONTROLS }

export class UI {

	constructor() {

		this.el = {
			body: document.body,
			boot: document.getElementById( 'boot' ),

			keyPrompt: document.getElementById( 'keyprompt' ),
			keyCard: document.getElementById( 'keyprompt-card' ),
			keyBody: document.getElementById( 'keyprompt-body' ),
			keyChapter: document.getElementById( 'keyprompt-chapter' ),
			keyCount: document.getElementById( 'keyprompt-count' ),
			keyCountVh: document.getElementById( 'keyprompt-count-vh' ),
			keyStepGet: document.getElementById( 'keystep-get' ),
			keyStepPaste: document.getElementById( 'keystep-paste' ),
			keyActGet: document.getElementById( 'keyact-get' ),
			keyActPaste: document.getElementById( 'keyact-paste' ),
			keyGet: document.getElementById( 'keyget' ),
			keyForm: document.getElementById( 'keyform' ),
			keyInput: document.getElementById( 'keyinput' ),
			keySave: document.getElementById( 'keysave' ),
			keyMessage: document.getElementById( 'keyprompt-msg' ),
			keyNoteLink: document.getElementById( 'keyprompt-msg-link' ),

			picker: document.getElementById( 'picker' ),
			searchForm: document.getElementById( 'searchform' ),
			search: document.getElementById( 'search' ),
			pickHint: document.getElementById( 'pickhint' ),
			places: document.getElementById( 'places' ),

			hud: document.getElementById( 'hud' ),
			loadingText: document.getElementById( 'loading-text' ),
			fps: document.getElementById( 'fps' ),

			bar: document.getElementById( 'bar' ),
			optPlace: document.getElementById( 'opt-place' ),
			optShape: document.getElementById( 'opt-shape' ),
			optMove: document.getElementById( 'opt-move' ),
			optHeight: document.getElementById( 'opt-height' ),
			shapes: document.getElementById( 'shapes' ),
			shapesList: document.getElementById( 'shapes-list' ),
			shapesClose: document.getElementById( 'shapes-close' ),
			moves: document.getElementById( 'moves' ),
			movesList: document.getElementById( 'moves-list' ),
			movesClose: document.getElementById( 'moves-close' ),
			heights: document.getElementById( 'heights' ),
			heightsClose: document.getElementById( 'heights-close' ),
			shotHeightStart: document.getElementById( 'shot-height-start' ),
			shotHeightStartOut: document.getElementById( 'shot-height-start-out' ),
			shotHeightFinish: document.getElementById( 'shot-height-finish' ),
			shotHeightFinishOut: document.getElementById( 'shot-height-finish-out' ),

			settings: document.getElementById( 'settings' ),
			settingsBtn: document.getElementById( 'btn-settings' ),
			settingsClose: document.getElementById( 'settings-close' ),

			stance: document.getElementById( 'stance' ),
			lookRows: document.getElementById( 'look-rows' ),
			cloudPass: document.getElementById( 'clouds-pass' ),
			tiltShift: document.getElementById( 'tiltshift' ),
			glow: document.getElementById( 'glow' ),
			sky: document.getElementById( 'sky' ),
			bend: document.getElementById( 'bend' ),
			bendOut: document.getElementById( 'bend-out' ),
			height: document.getElementById( 'height' ),
			heightOut: document.getElementById( 'height-out' ),
			training: document.getElementById( 'training' ),
			goLabel: document.querySelector( '.go-label' ),
			chrome: document.getElementById( 'chrome' ),
			view: document.getElementById( 'view' ),
			reset: document.getElementById( 'reset' ),
			record: document.getElementById( 'record' ),
			recRes: document.getElementById( 'rec-res' ),
			recFps: document.getElementById( 'rec-fps' ),
			recQuality: document.getElementById( 'rec-quality' ),
			recSize: document.getElementById( 'rec-size' ),
		}

		this.on = {
			key: null,
			place: null,
			bend: null,
			height: null,
			stance: null,
			shape: null,
			move: null,
			shotHeight: null,
			training: null,
			look: null,
			cloudPass: null,
			tiltShift: null,
			glow: null,
			sky: null,
			reset: null,
			record: null,
		}

		this.chromeHidden = false

		// The live value of every art-direction control, so a caller can read
		// the whole look back without touching the DOM.
		this.values = Object.fromEntries( LOOK_CONTROLS.map( c => [ c.key, c.value ] ) )
		this._lookInputs = new Map()

		// Bumped every time the card opens or a key is submitted, so a slow
		// verification that resolves after the next attempt cannot close it.
		this._keyGen = 0
		this._keyStep = 'paste'
		this._keyChecking = false
		this._keySlowTimer = 0
		this._keyNoticeTimer = 0

		this.shape = 'fold'
		this.stance = 'rooftop'

		// Which of the eight the CTA and the recorder will play. Live state with
		// no callback beside it, unlike Shape and Stance: choosing a move changes
		// nothing in the world until it is played, so there is nothing for the
		// wiring to be told. `main.js` reads it at the moment it starts one.
		this.move = DEFAULT_SHOT
		this._moveCells = new Map()
		this._shapeCells = new Map()
		this._shotHeights = new Map()
		this._recording = false
		this._training = false
		this._trainingReady = null
		this._bendLive = false
		this._fpsFrames = 0
		this._fpsTime = 0

		this._buildPlaces()
		this._bindKeyPrompt()
		this._buildShapes()
		this._buildMoves()
		this._buildLook()
		this._bindRecord()
		this._bind()

	}

	// ------------------------------------------------------------------ boot

	boot( text ) {

		this.el.boot.textContent = text || ''
		return this

	}

	/** What the status line currently says, so a caller can tell whether it still owns it. */
	get bootText() {

		return this.el.boot.textContent

	}

	bootDone() {

		this.el.body.classList.remove( 'state-boot' )
		return this.boot( '' )

	}

	// ------------------------------------------------------------------- key

	/** The generation a dismissal belongs to. See `keyAccepted`. */
	get keyGen() {

		return this._keyGen

	}

	/**
	 * Opens setup, or re-labels the one already open.
	 *
	 * Only the first call opens the card. A tile failure can arrive while
	 * somebody is reading step one; it gets to rewrite the notice, not to yank
	 * the screen out from under them. `stage` defaults to 'paste' because most
	 * of the ways in are a key that has stopped working — only a visitor we hold
	 * nothing for is walked through 'get'.
	 */
	askForKey( message, { invalid = false, quota = false, stage = 'paste' } = {} ) {

		const opening = this.el.keyPrompt.hidden
		this.el.keyPrompt.hidden = false
		this.el.body.classList.add( 'keyprompt-open' )
		this._setKeyGate( true )

		if ( opening ) {

			this._keyGen ++
			this.el.keyPrompt.classList.toggle( 'is-single', stage !== 'get' )
			this._showKeyStep( stage )

		}

		// Last, and synchronously: `_showKeyStep` has flushed the unhide, so the
		// live region is rendered before its text changes.
		this.keyNotice( message, { invalid, quota } )
		return this

	}

	/**
	 * Closes it, if the answer belongs to the card that is open.
	 *
	 * A verification that resolves after a *later* failure has reopened setup
	 * must not close that one — hence the generation.
	 */
	keyAccepted( gen ) {

		if ( gen !== undefined && gen !== this._keyGen ) return this

		this.keyChecking( false )
		this.keyNotice( '' )
		this.el.keyPrompt.hidden = true
		this.el.body.classList.remove( 'keyprompt-open' )
		this._setKeyGate( false )
		return this

	}

	/**
	 * The one thing the card ever says back, in the footer so no step change can
	 * hide it. Step-neutral on purpose: it is also how a rejection reaches
	 * somebody who has wandered back to the first screen.
	 */
	keyNotice( message, { invalid = false, quota = false } = {} ) {

		clearTimeout( this._keyNoticeTimer )

		const { text, href, label } = keyReason( message, quota )
		this.el.keyMessage.textContent = text
		this.el.keyPrompt.classList.toggle( 'has-error', invalid )
		if ( invalid ) this.el.keyInput.setAttribute( 'aria-invalid', 'true' )
		else this.el.keyInput.removeAttribute( 'aria-invalid' )

		this.el.keyNoteLink.hidden = ! href
		if ( href ) {

			this.el.keyNoteLink.href = href
			this.el.keyNoteLink.textContent = label

		}

		// A rejection is a reply to something somebody just did: they read it,
		// and after that it is only a red mark under the field. It takes itself
		// away, and the row it leaves stays open so the card does not resize.
		//
		// Two exceptions. A notice carrying a link, where the link *is* the fix
		// and has to still be there when they reach for it. And the explanation
		// screen, where nobody has done anything yet — a shared `?ion=` link
		// that was refused opens on 'get', and that message is the only answer
		// to why setup is up at all. Five seconds is not long enough to read a
		// screen; it is long enough to miss the sentence explaining it.
		if ( ! text || ! invalid || href || this._keyStep === 'get' ) return this
		this._keyNoticeTimer = setTimeout( () => this.keyNotice( '' ), KEY_NOTICE_MS )
		return this

	}

	/** Never navigates: an empty field must not move anybody off the screen. */
	keyRejected( message, { quota = false } = {} ) {

		this.keyNotice( message, { invalid: true, quota } )
		// Before the focus move: `select` needs the field out of readOnly.
		this.keyChecking( false )
		this.el.keyInput.focus( { preventScroll: true } )
		this.el.keyInput.select()
		return this

	}

	keyChecking( checking ) {

		this._keyChecking = checking
		this.el.keyPrompt.classList.toggle( 'is-checking', checking )
		this.el.keyForm.setAttribute( 'aria-busy', checking ? 'true' : 'false' )
		this.el.keyInput.readOnly = checking

		// aria-disabled, not disabled: disabling the button somebody just
		// clicked blurs focus to <body> and drops the only primary out of the
		// focus ring for a verification that can run twenty seconds.
		this.el.keySave.setAttribute( 'aria-disabled', String( checking ) )
		this.el.keyActPaste.querySelector( '.keyalt' ).setAttribute( 'aria-disabled', String( checking ) )
		this.el.keySave.querySelector( 'span' ).textContent = checking
			? this.el.keySave.dataset.busy
			: this.el.keySave.dataset.label

		clearTimeout( this._keySlowTimer )
		if ( ! checking ) return this
		// A round trip to the tile service can take fifteen seconds, and a
		// spinner alone is indistinguishable from a card that has stopped.
		this._keySlowTimer = setTimeout( () => {

			this.keyNotice( 'Still checking — the map service can take a few seconds.' )

		}, KEY_SLOW_MS )
		return this

	}

	/**
	 * Swaps the visible step. `hidden` rather than opacity, so the outgoing step
	 * leaves the box tree in the same frame: the focus ring is built from what
	 * has client rects, and two steps on screen at once would put the other
	 * screen's controls in the tab order.
	 */
	_showKeyStep( id, { back = false } = {} ) {

		const get = id === 'get'
		this._keyStep = id
		this.el.keyStepGet.hidden = ! get
		this.el.keyStepPaste.hidden = get
		this.el.keyActGet.hidden = ! get
		this.el.keyActPaste.hidden = get

		const single = this.el.keyPrompt.classList.contains( 'is-single' )
		this.el.keyChapter.textContent = single ? 'Setup' : get ? 'Your free key' : 'Paste it'
		this.el.keyCount.textContent = get ? '01 / 02' : '02 / 02'
		this.el.keyCountVh.textContent = `Step ${get ? 1 : 2} of 2`
		this.el.keyCard.style.setProperty( '--keystep', get ? '.5' : '1' )
		this.el.keyCard.setAttribute( 'aria-labelledby', get ? 'keyget-title' : 'keypaste-title' )
		this.el.keyPrompt.classList.toggle( 'is-back', back )
		this.el.keyPrompt.classList.toggle( 'is-step-get', get )

		// Going back to the explanation must not leave a rejection standing
		// under a heading it has nothing to do with.
		if ( get ) this.keyNotice( '' )

		// The card may have been unhidden in this same task, and a just-shown
		// step cannot take focus until the render tree catches up. Reading
		// layout does that now rather than a frame later — and rAF does not run
		// at all in a background tab, which is exactly where setup is answered.
		void this.el.keyBody.offsetHeight
		this.el.keyBody.scrollTop = 0
		const target = get ? this.el.keyStepGet.querySelector( 'h2' ) : this.el.keyInput
		target.focus( { preventScroll: true } )
		return this

	}

	/** Everything behind the card stops being reachable while it is up. */
	_setKeyGate( gated ) {

		for ( const element of document.querySelectorAll( '#view, #ui > :not(#keyprompt)' ) ) {

			element.inert = gated

		}

	}

	_bindKeyPrompt() {

		this.el.keyForm.addEventListener( 'submit', event => {

			event.preventDefault()
			if ( this._keyChecking ) return
			const value = this.el.keyInput.value.trim()
			if ( ! value ) return this.keyRejected( 'Paste your key to continue.' )
			this.keyNotice( '' )
			this._keyGen ++
			if ( this.on.key ) this.on.key( value )

		} )

		this.el.keyInput.addEventListener( 'input', () => {

			if ( this.el.keyPrompt.classList.contains( 'has-error' ) ) this.keyNotice( '' )

		} )

		// One gesture: the tab opens and the card moves on, so coming back from
		// the errand lands on a focused field with nothing left to decide.
		this.el.keyGet.addEventListener( 'click', () => this._showKeyStep( 'paste' ) )

		for ( const button of this.el.keyCard.querySelectorAll( '[data-key-step]' ) ) {

			button.addEventListener( 'click', () => {

				if ( this._keyChecking ) return
				this._showKeyStep( button.dataset.keyStep, { back: button.dataset.keyStep === 'get' } )

			} )

		}

		// On document, in capture: hiding the step that holds the focused
		// element blurs it to <body>, and a listener on the card would then
		// never fire — which is exactly when the trap has to hold.
		document.addEventListener( 'keydown', event => {

			if ( this.el.keyPrompt.hidden || event.key !== 'Tab' ) return

			const focusable = [ ...this.el.keyCard.querySelectorAll(
				'a[href], button:not([disabled]), input:not([disabled])',
			) ].filter( node => node.offsetParent !== null )
			if ( focusable.length === 0 ) return

			const first = focusable[ 0 ]
			const last = focusable[ focusable.length - 1 ]
			const active = document.activeElement

			// Setup is a gate. There is nothing behind it worth tabbing to, and
			// letting focus escape into an inert tree strands it there.
			if ( event.shiftKey && ( active === first || ! this.el.keyCard.contains( active ) ) ) {

				event.preventDefault()
				last.focus()

			} else if ( ! event.shiftKey && active === last ) {

				event.preventDefault()
				first.focus()

			}

		}, true )

	}

	// ---------------------------------------------------------------- places

	openPicker() {

		// It is a modal, so nothing else may be open behind it. The document
		// pointerdown listener would have closed a popover on the way through,
		// but only for a press — reaching Location by keyboard fires `click` with
		// no pointerdown in front of it.
		for ( const name of MENUS ) this._closeMenu( name )
		this._toggleSettings( false )

		this.el.picker.hidden = false
		this.el.search.value = ''
		this.el.pickHint.textContent = ''
		requestAnimationFrame( () => this.el.search.focus() )
		return this

	}

	closePicker() {

		this.el.picker.hidden = true
		return this

	}

	/**
	 * The last visit this browser had — city, walk, height, animation, look —
	 * or the picker the first time.
	 *
	 * The old key was only a destination id, so a dropped pin and every slider
	 * were forgotten on reload. The session is the whole bar; the id is kept
	 * beside it so a browser that only has the older key still opens a city.
	 */
	restoreLastPlace() {

		const session = this.readSession()
		const destination = this._destinationFromSession( session )
		if ( destination ) return this._choose( destination, session )

		this.openPicker()
		return this

	}

	readSession() {

		try {

			const raw = localStorage.getItem( LAST_SESSION )
			if ( ! raw ) return null
			const data = JSON.parse( raw )
			return data && data.v === 1 ? data : null

		} catch {

			return null

		}

	}

	writeSession( data ) {

		if ( ! data ) return this

		try {

			localStorage.setItem( LAST_SESSION, JSON.stringify( data ) )
			const id = data.place?.id
			if ( id && id !== 'custom' ) localStorage.setItem( LAST_PLACE, id )

		} catch {

			// Private mode and full disks throw; a missed write is not worth
			// interrupting the frame that tried to save.

		}

		return this

	}

	_destinationFromSession( session ) {

		const place = session?.place
		if ( place?.id && place.id !== 'custom' ) {

			const found = DESTINATIONS.find( d => d.id === place.id )
			if ( found ) return found

		}

		if ( place && Number.isFinite( place.lat ) && Number.isFinite( place.lon ) ) {

			return coordDestination( place.lat, place.lon, { name: place.name } )

		}

		const id = localStorage.getItem( LAST_PLACE )
		return DESTINATIONS.find( d => d.id === id ) || null

	}

	setPlace( destination ) {

		this.el.hud.hidden = false
		this.el.optPlace.querySelector( '.opt-value' ).textContent = destination.name
		this.el.optPlace.title = [ destination.place, destination.country ].filter( Boolean ).join( ' · ' )
		return this

	}

	// ------------------------------------------------------------------- hud

	setLoading( count ) {

		this.el.body.classList.toggle( 'tiles-quiet', count === 0 )
		this.el.loadingText.textContent = count === 0
			? 'City loaded'
			: `Streaming · ${count}`
		return this

	}

	/**
	 * The frame cost, averaged over a window rather than taken from one `dt`.
	 *
	 * A per-frame reciprocal reads as noise — a single 3 ms hitch on an
	 * otherwise steady 60 shows up as 42 — and the number is being read while
	 * something heavy is happening, so it has to be stable enough to compare
	 * against itself a second later. Half a second is short enough to see the
	 * cost arrive as the fold closes and long enough not to flicker. The DOM is
	 * written once per window, not once per frame.
	 */
	setFps( dt ) {

		this._fpsFrames ++
		this._fpsTime += dt
		if ( this._fpsTime < 0.5 ) return this

		const fps = this._fpsFrames / this._fpsTime
		const ms = ( this._fpsTime / this._fpsFrames ) * 1000
		this._fpsFrames = 0
		this._fpsTime = 0

		this.el.fps.textContent = `${Math.round( fps )} fps · ${ms.toFixed( 1 )} ms`
		this.el.fps.classList.toggle( 'is-low', fps < 50 )
		return this

	}

	/** Called from the frame loop; ignored while the viewer is holding the slider. */
	setBend( amount ) {

		this.el.bendOut.textContent = `${Math.round( amount * 180 )}°`
		this.el.body.classList.toggle( 'state-folding', amount > 0.08 )

		if ( ! this._bendLive ) this.el.bend.value = String( Math.round( amount * 1000 ) )
		return this

	}

	setHeight( metres ) {

		this.el.heightOut.textContent = formatHeight( metres )

		if ( document.activeElement !== this.el.height ) {

			this.el.height.value = String( heightToSlider( metres ) )

		}

		return this

	}

	/** Takes the whole interface off the picture, or puts it back. */
	setChrome( hidden ) {

		this.chromeHidden = Boolean( hidden )
		this.el.body.classList.toggle( 'chrome-hidden', this.chromeHidden )
		this.el.chrome.setAttribute( 'aria-pressed', String( this.chromeHidden ) )
		this.el.chrome.setAttribute( 'aria-label', this.chromeHidden ? 'Show the controls' : 'Hide the controls' )
		return this

	}

	setShape( shape ) {

		this.shape = FOLD_SHAPES[ shape ] ? shape : 'fold'
		this.el.optShape.querySelector( '.opt-value' ).textContent = FOLD_SHAPES[ this.shape ].label
		return this._mark( this._shapeCells, this.shape )

	}

	_buildShapes() {

		this._shapeCells = this._buildOptions( this.el.shapesList, SHAPE_LIST, shape => {

			this.setShape( shape.id )
			if ( this.on.shape ) this.on.shape( shape.id )
			this._closeMenu( 'shapes' )

		} )

		return this.setShape( this.shape )

	}

	/** Writes a look control from outside — a preset moving its own sliders. */
	setLook( key, value ) {

		const input = this._lookInputs.get( key )
		if ( ! input ) return this

		this.values[ key ] = value
		input.el.value = String( value )
		input.out.textContent = input.control.format( value )
		return this

	}

	/**
	 * Names the move the CTA will play.
	 *
	 * Written from outside as well as clicked: a recording drives `playShot`
	 * itself, and `world.onShot` puts the answer back here so the lit cell and
	 * the picture cannot disagree about which of the eight is running.
	 */
	setMove( id ) {

		this.move = this._moveCells.has( id ) ? id : DEFAULT_SHOT
		const shot = SHOTS.find( s => s.id === this.move )
		this.el.optMove.querySelector( '.opt-value' ).textContent = shot ? shot.short : ''
		this._mark( this._moveCells, this.move )
		return this._syncShotHeight()

	}

	/** The visible start and finish heights saved for one animation. */
	readShotHeight( id = this.move ) {

		const range = this._shotHeight( id )
		return { start: range.start, finish: range.finish }

	}

	readShotHeights() {

		return Object.fromEntries( SHOTS.map( shot => {

			const range = this._shotHeight( shot.id )
			return [ shot.id, { start: range.start, finish: range.finish } ]

		} ) )

	}

	setShotHeights( map ) {

		if ( ! map ) return this

		for ( const shot of SHOTS ) {

			const range = map[ shot.id ]
			if ( ! range ) continue
			const start = Number( range.start )
			const finish = Number( range.finish )
			if ( ! Number.isFinite( start ) || ! Number.isFinite( finish ) ) continue
			this._shotHeights.set( shot.id, {
				start: Math.min( MAX_HEIGHT, Math.max( MIN_HEIGHT, start ) ),
				finish: Math.min( MAX_HEIGHT, Math.max( MIN_HEIGHT, finish ) ),
			} )

		}

		return this._syncShotHeight()

	}

	setPassToggles( { clouds, tilt, glow } = {} ) {

		if ( clouds !== undefined ) this.el.cloudPass.checked = Boolean( clouds )
		if ( tilt !== undefined ) this.el.tiltShift.checked = Boolean( tilt )
		if ( glow !== undefined ) this.el.glow.checked = Boolean( glow )
		return this

	}

	setSkyHex( hex ) {

		const n = Math.round( Number( hex ) )
		if ( ! Number.isFinite( n ) ) return this
		this.el.sky.value = `#${Math.max( 0, n ).toString( 16 ).padStart( 6, '0' )}`
		return this

	}

	_shotHeight( id ) {

		if ( this._shotHeights.has( id ) ) return this._shotHeights.get( id )

		const shot = SHOTS.find( candidate => candidate.id === id )
		const track = shot?.tracks.height
		const start = track
			? sampleTrack( track, shot.duration * ( shot.start || 0 ) )
			: MIN_HEIGHT
		const finish = track ? sampleTrack( track, shot.duration ) : start
		const range = { start, finish }
		this._shotHeights.set( id, range )
		return range

	}

	_setShotHeight( edge, metres ) {

		const range = this._shotHeight( this.move )
		range[ edge ] = Math.min( MAX_HEIGHT, Math.max( MIN_HEIGHT, metres ) )
		this._syncShotHeight()
		if ( this.on.shotHeight ) this.on.shotHeight( this.move, range.start, range.finish )
		return this

	}

	_syncShotHeight() {

		const range = this._shotHeight( this.move )
		const { shotHeightStart, shotHeightStartOut, shotHeightFinish, shotHeightFinishOut } = this.el
		shotHeightStart.value = String( heightToSlider( range.start ) )
		shotHeightFinish.value = String( heightToSlider( range.finish ) )
		shotHeightStartOut.textContent = formatHeight( range.start )
		shotHeightFinishOut.textContent = formatHeight( range.finish )

		const value = this.el.optHeight.querySelector( '.opt-value' )
		value.textContent = `${Math.round( range.start )} → ${Math.round( range.finish )} m`
		this.el.optHeight.title =
			`Animation height: ${formatHeight( range.start )} to ${formatHeight( range.finish )}`
		return this

	}

	_buildMoves() {

		this._moveCells = this._buildOptions( this.el.movesList, SHOTS, shot => {

			this.setMove( shot.id )
			if ( this.on.move ) this.on.move( shot.id )
			this._closeMenu( 'moves' )

		} )

		return this.setMove( this.move )

	}

	/**
	 * The rows both lists are made of: a number, a name and the one line that
	 * says what the thing actually does.
	 *
	 * The description is the whole reason these are lists rather than a button
	 * that cycles. A bend and a move are each a choice between things that are
	 * not variations on one another, and a name alone — `Tube`, `Gaze` — does
	 * not tell anybody which one they want.
	 */
	_buildOptions( host, entries, onPick ) {

		const cells = new Map( entries.map( ( entry, index ) => {

			const button = document.createElement( 'button' )
			button.type = 'button'
			button.className = 'opt-option'
			button.dataset.id = entry.id
			button.setAttribute( 'aria-pressed', 'false' )
			button.innerHTML = '<span class="opt-index"></span><span class="opt-copy"><b></b><i></i></span>'

			const [ number, copy ] = button.children
			number.textContent = String( index + 1 ).padStart( 2, '0' )
			copy.querySelector( 'b' ).textContent = entry.name || entry.label
			copy.querySelector( 'i' ).textContent = entry.note || ''
			button.addEventListener( 'click', () => onPick( entry ) )
			return [ entry.id, button ]

		} ) )

		host.replaceChildren( ...cells.values() )
		return cells

	}

	/** Exactly one row in a list is the current one. */
	_mark( cells, id ) {

		for ( const [ key, button ] of cells ) button.setAttribute( 'aria-pressed', String( key === id ) )
		return this

	}

	// ------------------------------------------------------------- popovers

	/**
	 * Open state lives as a class on `<body>`, not on the popover.
	 *
	 * That is what lets the backdrop, the caret, the trigger's underline and the
	 * panel itself all react to one flag without any of them holding a reference
	 * to the others — and it is how the sibling project does it, so the two
	 * interfaces stay the same interface.
	 */
	_toggleMenu( name, force ) {

		const open = force === undefined ? ! this.el.body.classList.contains( `${name}-open` ) : force
		if ( open ) for ( const other of MENUS ) if ( other !== name ) this._closeMenu( other )
		if ( open ) this._toggleSettings( false )

		this.el.body.classList.toggle( `${name}-open`, open )
		const trigger = this.el[ MENU_NODES[ name ].trigger ]
		trigger.setAttribute( 'aria-expanded', String( open ) )
		return this

	}

	_closeMenu( name ) {

		return this._toggleMenu( name, false )

	}

	_toggleSettings( force ) {

		const open = force === undefined ? ! this.el.body.classList.contains( 'settings-open' ) : force
		if ( open ) for ( const name of MENUS ) this._closeMenu( name )

		this.el.body.classList.toggle( 'settings-open', open )
		this.el.settingsBtn.setAttribute( 'aria-expanded', String( open ) )
		return this

	}

	setStance( stance ) {

		this.stance = STANCE_LABELS[ stance ] ? stance : 'rooftop'
		this.el.stance.value = this.stance
		return this

	}

	// ------------------------------------------------------------------ wire

	_buildPlaces() {

		const list = this.el.places
		list.replaceChildren( ...DESTINATIONS.map( destination => {

			const item = document.createElement( 'li' )
			item.tabIndex = 0
			item.dataset.id = destination.id
			item.innerHTML = `<em>${destination.cat}</em><span class="col"><b></b><small></small></span>`
			item.querySelector( 'b' ).textContent = destination.name
			item.querySelector( 'small' ).textContent =
				`${destination.place} · ${destination.country}`

			const pick = () => this._choose( destination )
			item.addEventListener( 'click', pick )
			item.addEventListener( 'keydown', event => {

				if ( event.key === 'Enter' || event.key === ' ' ) {

					event.preventDefault()
					pick()

				}

			} )

			return item

		} ) )

	}

	/** `frame` and `total` drive the label while a capture runs. */
	setRecording( active, frame = 0, total = 0 ) {

		this._recording = active
		const button = this.el.record
		button.setAttribute( 'aria-pressed', String( active ) )
		button.title = active
			? 'Stop recording (Esc)'
			: 'Record this move to a video file'
		button.querySelector( 'span' ).textContent = ! active
			? 'REC'
			: total ? `${Math.round( frame / total * 100 )}%` : 'STOP'
		this.el.body.classList.toggle( 'is-recording', active )
		// A capture drives the world itself, so nothing else may — including the
		// three bar options, one of which names the move the capture is already
		// halfway through recording.
		this.el.training.disabled = active || ! this._trainingReady
		this.el.optShape.disabled = active
		this.el.optMove.disabled = active
		this.el.optHeight.disabled = active
		this.el.optPlace.disabled = active
		for ( const input of [ this.el.recRes, this.el.recFps, this.el.recQuality ] ) {

			input.disabled = active

		}
		return this

	}

	setTraining( active ) {

		this._training = active
		this.el.goLabel.textContent = active
			? this.el.training.dataset.running
			: this.el.training.dataset.label
		this.el.training.setAttribute( 'aria-pressed', String( active ) )
		this.el.body.classList.toggle( 'is-playing', active )
		// A move that has started closes everything that was open over the top of
		// it; the panel is about to fade out from under the pointer anyway.
		if ( active ) {

			for ( const name of MENUS ) this._closeMenu( name )
			this._toggleSettings( false )

		}

		return this

	}

	setTrainingReady( ready ) {

		if ( ready === this._trainingReady ) return this
		this._trainingReady = ready
		this.el.training.disabled = ! ready
		this.el.training.title = ready ? '' : 'Waiting for the street to finish loading'
		return this

	}

	/** Pushes a whole look object back into the panel — see `World.readLook`. */
	syncLook( values ) {

		for ( const key in values ) this.setLook( key, values[ key ] )
		return this

	}

	_buildLook() {

		this.el.lookRows.replaceChildren( ...LOOK_CONTROLS.map( control => {

			const row = document.createElement( 'label' )
			row.className = 'slider'
			row.innerHTML = '<span></span><input type="range"><output></output>'

			const [ span, input, out ] = row.children
			span.textContent = control.label
			input.min = control.min
			input.max = control.max
			input.step = control.step
			input.value = control.value
			input.setAttribute( 'aria-label', control.label )
			out.textContent = control.format( control.value )

			input.addEventListener( 'input', () => {

				const value = Number( input.value )
				this.values[ control.key ] = value
				out.textContent = control.format( value )
				if ( this.on.look ) this.on.look( control.key, value )

			} )

			this._lookInputs.set( control.key, { el: input, out, control } )
			return row

		} ) )

	}

	_bindRecord() {

		this.recordValues = { resolution: 1080, fps: 60, quality: 'balanced' }

		const bind = ( input, key, numeric ) => {

			const push = () => {

				const raw = input.value
				this.recordValues[ key ] = numeric ? Number( raw ) : raw
				this._syncRecordHint()

			}
			input.addEventListener( 'change', push )
			push()

		}

		bind( this.el.recRes, 'resolution', true )
		bind( this.el.recFps, 'fps', true )
		bind( this.el.recQuality, 'quality', false )
		addEventListener( 'resize', () => this._syncRecordHint() )

	}

	_syncRecordHint() {

		const live = window.innerWidth / Math.max( window.innerHeight, 1 )
		const aspect = live > 0.2 && live < 5 ? live : 16 / 9
		const { width, height } = captureSize( {
			resolution: this.recordValues.resolution,
			aspect,
		} )
		this.el.recSize.textContent = `${width} × ${height} at ${this.recordValues.fps} fps`

	}

	_choose( destination, session ) {

		if ( destination.id !== 'custom' ) localStorage.setItem( LAST_PLACE, destination.id )
		this.closePicker()
		this.setPlace( destination )
		if ( this.on.place ) this.on.place( destination, session )
		return this

	}

	_bind() {

		const el = this.el

		el.searchForm.addEventListener( 'submit', event => {

			event.preventDefault()
			const { destination, source, reason } = parseLocation( el.search.value )
			if ( destination ) {

				el.pickHint.textContent = ''
				this._choose( destination )
				return

			}

			el.pickHint.textContent = reason || `Nothing in that ${source || 'text'}`

		} )

		el.optPlace.addEventListener( 'click', () => this.openPicker() )

		el.picker.addEventListener( 'click', event => {

			// Clicking the scrim closes, but only once there is something behind
			// it — the first visit has no view to go back to.
			if ( event.target === el.picker && ! el.hud.hidden ) this.closePicker()

		} )

		el.optShape.addEventListener( 'click', () => this._toggleMenu( 'shapes' ) )
		el.optMove.addEventListener( 'click', () => this._toggleMenu( 'moves' ) )
		el.optHeight.addEventListener( 'click', () => this._toggleMenu( 'heights' ) )
		el.shapesClose.addEventListener( 'click', () => this._closeMenu( 'shapes' ) )
		el.movesClose.addEventListener( 'click', () => this._closeMenu( 'moves' ) )
		el.heightsClose.addEventListener( 'click', () => this._closeMenu( 'heights' ) )

		el.settingsBtn.addEventListener( 'click', () => this._toggleSettings() )
		el.settingsClose.addEventListener( 'click', () => this._toggleSettings( false ) )

		// One capture-phase listener closes whichever surface the press landed
		// outside of. Capture, because a row's own click handler closes the menu
		// it lives in and would otherwise have removed the target from the tree
		// by the time a bubbling listener asked whether it was inside.
		document.addEventListener( 'pointerdown', event => {

			for ( const name of MENUS ) {

				const open = el.body.classList.contains( `${name}-open` )
				if ( ! open ) continue
				const nodes = MENU_NODES[ name ]
				const menu = el[ nodes.panel ]
				const trigger = el[ nodes.trigger ]
				if ( ! menu.contains( event.target ) && ! trigger.contains( event.target ) ) {

					this._closeMenu( name )

				}

			}

			if ( el.body.classList.contains( 'settings-open' )
				&& ! el.settings.contains( event.target )
				&& ! el.settingsBtn.contains( event.target ) ) this._toggleSettings( false )

		}, true )

		el.stance.addEventListener( 'change', () => {

			this.stance = el.stance.value
			if ( this.on.stance ) this.on.stance( this.stance )

		} )

		el.cloudPass.addEventListener( 'change', () => {

			if ( this.on.cloudPass ) this.on.cloudPass( el.cloudPass.checked )

		} )

		el.tiltShift.addEventListener( 'change', () => {

			if ( this.on.tiltShift ) this.on.tiltShift( el.tiltShift.checked )

		} )

		el.glow.addEventListener( 'change', () => {

			if ( this.on.glow ) this.on.glow( el.glow.checked )

		} )

		el.sky.addEventListener( 'input', () => {

			if ( this.on.sky ) this.on.sky( parseInt( el.sky.value.slice( 1 ), 16 ) )

		} )

		el.bend.addEventListener( 'pointerdown', () => { this._bendLive = true } )
		const endBend = () => { this._bendLive = false }
		el.bend.addEventListener( 'pointerup', endBend )
		el.bend.addEventListener( 'pointercancel', endBend )
		el.bend.addEventListener( 'blur', endBend )

		el.bend.addEventListener( 'input', () => {

			const amount = Number( el.bend.value ) / 1000
			this.setBend( amount )
			if ( this.on.bend ) this.on.bend( amount )

		} )

		el.height.addEventListener( 'input', () => {

			const metres = heightFromSlider( el.height.value )
			this.setHeight( metres )
			if ( this.on.height ) this.on.height( metres )

		} )

		el.shotHeightStart.addEventListener( 'input', () => {

			const metres = heightFromSlider( el.shotHeightStart.value )
			this._setShotHeight( 'start', metres )

		} )

		el.shotHeightFinish.addEventListener( 'input', () => {

			const metres = heightFromSlider( el.shotHeightFinish.value )
			this._setShotHeight( 'finish', metres )

		} )

		el.training.addEventListener( 'click', () => {

			if ( this.on.training ) this.on.training( this._training )

		} )

		// While a move is running the interface is not on screen, so the picture
		// has to be the control: a click anywhere gives it back. Bound to the
		// canvas rather than the window so the one press that started it cannot
		// also stop it, and so the buttons that are still technically in the DOM
		// do not have to guard against it.
		//
		// A capture is playing a shot too, and there the same click would stop it
		// silently: the recorder keeps encoding, the file still saves, and its
		// back half is a frozen frame. During one, the bar comes back instead —
		// the record button and Escape are the way out.
		el.view.addEventListener( 'pointerdown', () => {

			if ( this._recording ) return
			if ( this._training && this.on.training ) this.on.training( true )

		} )

		el.record.addEventListener( 'click', () => {

			if ( this.on.record ) this.on.record( this._recording )

		} )

		el.reset.addEventListener( 'click', () => {

			if ( this.on.reset ) this.on.reset()

		} )

		el.chrome.addEventListener( 'click', () => this.setChrome( ! this.chromeHidden ) )

		// Escape backs out of whatever is over the picture, innermost first. A
		// capture is the exception: it is not a surface, and the rec button is
		// otherwise the only way out, so Escape stops it before it closes a
		// menu. The setup card is not in this list: it is a gate rather than a
		// surface, and there is nothing behind it to go back to.
		addEventListener( 'keydown', event => {

			if ( event.key !== 'Escape' ) return
			if ( this._recording ) {

				event.preventDefault()
				if ( this.on.record ) this.on.record( true )
				return

			}

			const body = el.body
			if ( MENUS.some( name => body.classList.contains( `${name}-open` ) ) ) {

				for ( const name of MENUS ) this._closeMenu( name )
				return

			}

			if ( body.classList.contains( 'settings-open' ) ) return void this._toggleSettings( false )
			if ( ! el.picker.hidden && ! el.hud.hidden ) this.closePicker()

		} )

		addEventListener( 'keydown', event => {

			if ( event.code !== 'KeyH' || event.metaKey || event.ctrlKey || event.altKey ) return
			// Not while the search box or a slider has the keyboard.
			const target = event.target
			if ( target && ( target.tagName === 'INPUT' || target.isContentEditable ) ) return
			event.preventDefault()
			this.setChrome( ! this.chromeHidden )

		} )

		// The tip is advice for the first ten seconds, not a permanent label.
		const touched = () => el.body.classList.add( 'touched' )
		addEventListener( 'pointerdown', touched, { once: true } )
		addEventListener( 'wheel', touched, { once: true, passive: true } )

	}

}
